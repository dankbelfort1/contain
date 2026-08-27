# ContAIn

**A secret-leak remediation agent you would trust near production.**

*Contain* is the incident-response term for the phase where you stop a compromised
credential doing further damage. It is also what we do to the agent.

> **The agent earns information, not permissions.**
> It investigates progressively, but destructive authority stays behind a human trust
> boundary.

---

## The problem

A credential gets committed to a repository. Someone has to work out whether it still
works, what it can reach, and whether killing it will break production. That
investigation is slow and manual, so it gets deferred, and the credential stays live.

Automating it is the obvious move and also the dangerous one, because the same agent
that investigates could revoke a key that production depends on.

## The idea

Split the two. Give the agent as much *investigative* reach as it needs, and no
*destructive* authority at all. It can look at anything. It cannot break anything. A
human unlocks the single irreversible step.

## The loop

```
Discover -> Verify -> Assess blast radius -> Plan -> [HUMAN APPROVAL] -> Revoke -> Audit
```

| Step | What happens | Needs a human? |
| --- | --- | --- |
| **Discover** | gitleaks walks the repository and its full git history | no |
| **Verify** | a vetted read-only template runs in a network-restricted sandbox | no |
| **Assess** | for live keys, enumerate what the key can actually reach | no |
| **Plan** | one remediation item per finding, each with a stated reason | no |
| **Approve** | the agent stops | **yes** |
| **Revoke** | one real API call, then re-verify to prove the key is dead | no |
| **Audit** | every step above recorded, start to finish | no |

## Where the trust boundary actually lives

Not in the UI, and not in an `if (approved)` branch that someone could delete.

The tools are published as an MCP server, and each one carries an annotation describing
what it does to the world:

| Tool | Annotation |
| --- | --- |
| `scan_repository` | read-only |
| `verify_credential` | read-only |
| `build_remediation_plan` | read-only |
| `read_audit_trail` | read-only |
| `revoke_credential` | **destructive** |

TrueForge is configured with `require_approval_for_tools: ["@destructive"]` and resolves
that selector from those annotations.

So the gate is a property of the tool manifest. Read-only investigation runs freely. The
destructive tool is not reachable without a human decision. A dangerous tool added later
is gated automatically, as long as it is annotated honestly. There is no code path to
forget.

Two layers of test pin this down. One asserts the annotations in our own module. The
other connects a real MCP client over the wire and asserts what it actually receives,
because that is what TrueForge resolves the selector against.

## Try it

Requires Node 22.14 or newer. Nothing else needs installing; the scanner is fetched
automatically with its checksum verified.

```bash
npm install
cp .env.example .env      # add two GitHub PATs from a throwaway account
npm run fixtures          # build the demo repository
npm run demo:dry          # run the whole loop, never revokes anything
```

`npm run demo:dry` does everything except fire. Drop `:dry` to run it for real, at which
point the approval gate becomes live and asks you to type `revoke` to confirm.

For the visual version:

```bash
npm run ui:build
npm run ui                # http://localhost:8910
```

To drive it from a TrueForge agent instead:

```bash
npm run mcp               # http://localhost:8900/mcp
```

Then add that URL under **Settings, Connectors** in TrueForge, and create an agent from
`src/agent/spec.ts`.

## What the demo shows

The fixture repository plants three credentials. The interesting one is committed and
then deleted in a later commit, so it appears nowhere in the current code and only a
scan of full git history finds it. That is the shape most real leaks take.

```
1/6  Scan repository and full git history
  3 credential(s) found

2/6  Verify each credential in a sandbox
   LIVE   ghp_****ZTHG  deploy/staging.yml:5
         Live on the account "Dank-Burner". Anyone holding this key can
         administer the enterprise account, administer organisations,
         including who belongs to them, and permanently delete repositories.
         Plus 18 further permissions.

   DEAD   ghp_****1KOc  .github/workflows/ci.yml:10
   DEAD   ghp_****r4vz  test/helpers.js:2

4/6  Human approval
┌──────────────────────────────────────────────────────────────────────┐
│  HUMAN APPROVAL REQUIRED                                             │
│  This action may affect production.                                  │
└──────────────────────────────────────────────────────────────────────┘
```

## Layout

```
src/
  tools/       scanner (wraps gitleaks), verify, revoke
  templates/   vetted read-only verification templates, blast radius wording
  sandbox/     isolated execution with an egress allowlist
  policy/      approval registry and the rules that decide actions
  agent/       remediation plan, TrueForge agent spec
  harness/     audit trail
  mcp/         MCP server, tool annotations, run state
  server/      HTTP API behind the UI
  cli/         terminal interface
  fixtures/    builds the demo repository
ui/            React workflow view
tests/         100 tests
docs/          Phase 0 go/no-go findings
```

## Things we decided not to fudge

**A successful revoke call does not prove revocation.** GitHub's endpoint returns
`202 Accepted` unconditionally and acts asynchronously. A token that never existed gets
the same response a real one does. So we never record "revoked" from the HTTP status; we
re-run the read-only verification afterwards and record what we observed. When the
credential still authenticates, the record says so instead of claiming success.

**The sandbox is a strong boundary, not a jail.** Egress is restricted to an allowlist,
enforced in-process. That reliably stops a vetted template reaching anywhere it should
not. It would not contain deliberately hostile code. Our threat model is "a template has
a bug", not "a template is an attacker", because templates are fixed and reviewed rather
than written by the model at runtime.

**Verification is template-based, not improvised.** The model chooses which vetted
template to run and fills in parameters. It does not write probe code. That is what makes
live/dead classification reproducible run to run.

**UNKNOWN is a real answer.** If verification cannot establish whether a credential
works, it says so and a human decides. A wrong DEAD leaves a working credential in place.

**The approval is bound to a credential, not just granted.** GitHub's revoke endpoint is
unauthenticated and will destroy any token submitted to it, so "a human approved
something" is not a control. Each approval carries a digest of the exact credential it
covers, and is spent exactly once.

## Safety properties, each with a test

- verification templates issue only `GET` or `HEAD`, and cannot reach the revoke endpoint
- the sandbox blocks any host not on the allowlist, and blocks everything when the
  allowlist is empty, including positional `connect(port, host)` calls, connections to a
  literal IP that never touch DNS, and IPC paths
- the sandbox does not inherit the host environment, so a template cannot read ambient
  credentials
- revoke is unreachable without an approval, and in every refusal case **no request is
  sent at all**
- an approval for a different finding, or a different credential value, is refused
- with an approval, revoke fires exactly once even when retried
- a policy cannot un-gate a destructive action, whatever it sets
- a non-202 response is not reported as an attempted revocation, and confirmation
  requires an observed transition from live to dead
- text taken from the scanned repository cannot inject terminal control sequences into
  the approval panel
- dry run and replay never fire
- no audit event can contain a raw credential
- the same repository in the same state produces identical findings, statuses and plan

## Documentation

- [`docs/phase-0.md`](docs/phase-0.md) - the go/no-go findings that shaped the design
- [`docs/demo.md`](docs/demo.md) - the demo script, step by step

## Built with

[TrueForge](https://trueforge.dev) for the agent harness, [gitleaks](https://gitleaks.io)
for detection, [Daytona](https://www.daytona.io) for sandboxing, Gemini for the model, and
[Qodo](https://www.qodo.ai) reviewing every pull request.
