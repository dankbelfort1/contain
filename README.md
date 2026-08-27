# ContAIn

**A secret-leak remediation agent you would trust near production.**

*Contain* is the incident-response term for the phase where you stop a compromised
credential doing further damage. It is also what we do to the agent.

> The agent earns information, not permissions.
> It investigates progressively, but destructive authority stays behind a human trust boundary.

## The problem

A credential gets committed to a repo. Someone has to find out whether it still works,
what it can reach, and whether killing it will break production. That investigation is
slow and manual. Automating it is dangerous, because the same agent that investigates
could revoke a key that production depends on.

## The idea

Split the two. The agent is given as much *investigative* reach as it needs, and no
*destructive* authority at all. It can look at anything. It cannot break anything.
A human unlocks the one irreversible step.

## The loop

    Discover -> Verify -> Assess blast radius -> Plan -> [HUMAN APPROVAL] -> Revoke -> Audit

1. **Discover** - a real scanner (gitleaks) walks the repo and its full git history.
2. **Verify** - a vetted, read-only template runs in a sandbox and calls the provider.
3. **Assess** - for live keys, enumerate what the key can actually reach, read-only.
4. **Plan** - one remediation item per finding, each with a stated reason.
5. **Approve** - the agent stops. A human allows or denies. This is a hard stop.
6. **Revoke** - one real API call, then re-verify to prove the key is dead.
7. **Audit** - every step above recorded, start to finish.

## Where the trust boundary actually lives

Not in the UI, and not in an `if approved:` branch someone could delete.

Our tools are published as an MCP server. Each tool carries an MCP annotation
describing what it does: the scanner and the verification templates are annotated
**read-only**; the revoke tool is annotated **destructive**. TrueForge is configured with
`require_approval_for_tools: ["@destructive"]`, and resolves that selector from those
annotations.

So the gate is a property of the tool manifest, not of our control flow. Read-only
investigation runs freely. The destructive tool is not reachable without a human
decision. Adding a new dangerous tool gates it automatically; there is no code path to
forget.

## Honest limits

We would rather state these than overclaim:

- **The sandbox is a strong boundary, not a jail.** Egress is restricted to an
  allowlist, enforced in-process. That reliably stops vetted templates from reaching
  anywhere they shouldn't. It would not contain deliberately hostile code. Our threat
  model is "a template has a bug", not "a template is an attacker", because templates
  are fixed and reviewed rather than written by the model at runtime.
- **Verification is template-based, not improvised.** The model chooses which vetted
  template to run and fills in parameters. It does not write probe code. This is what
  makes live/dead classification reproducible.
- **A successful revoke call does not prove revocation.** GitHub's endpoint returns
  `202 Accepted` unconditionally and acts asynchronously - a fake token gets the same
  response a real one does. So we never record "revoked" from the HTTP status. We
  re-run the read-only verification afterwards and record the observed flip to dead.

## Status

Phase 0 complete. See `docs/phase-0.md` for the go/no-go findings.
