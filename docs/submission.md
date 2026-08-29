# Submission answers

Copy and paste. Every field on the form, filled.

---

## Team name

```
SOLO
```

## Name of the person submitting

```
Deep Shah
```

## Track you are submitting for

Tick all three. The same project can go into every track, and you can only win one
anyway, so there is no reason to leave any unticked.

- [x] Best Use of TrueForge (NVIDIA DGX Spark)
- [x] Best Code Quality (Mac Mini)
- [x] Best UI (Apple iPads)
- [ ] Best Blog Post - only tick this if you publish the blog post

## GitHub link to project

```
https://github.com/dankbelfort1/contain
```

## Deployed link to project

Leave blank. The project runs locally on purpose: it holds live credentials and can
permanently destroy them, so a public deployment would be the wrong thing to build.

---

## What does your project do?

```
ContAIn is a secret-leak remediation agent.

When a credential gets committed to a repository, someone has to work out three things
by hand: does it still work, what can it reach, and will killing it break production.
That takes hours, so it gets deferred, and the credential stays live in the meantime.

Automating it is the obvious move and also the dangerous one, because the same agent
that investigates could revoke a key that production depends on. So nobody does it.

ContAIn splits those two things apart. The agent gets as much investigative reach as it
needs and no destructive authority at all. It scans a repository's full git history with
gitleaks, verifies each credential it finds by running a vetted read-only probe inside a
network-restricted sandbox, and reports the blast radius in plain words: "Anyone holding
this key can administer the enterprise account, administer organisations, and permanently
delete repositories."

Then it stops. It cannot revoke anything. A human decides, and only then does it make one
real API call to GitHub and re-verify to prove the key is actually dead.

It is for the engineer who gets paged about a leaked key and has to decide, quickly and
under pressure, whether killing it is safe.
```

## How did you use TrueForge in your project?

```
The tools are published as an MCP server that TrueForge connects to. There are five, and
each declares an MCP annotation describing what it does to the world: the scanner, the
verifier, the blast radius assessment and the planner are annotated read-only. Exactly
one, revoke_credential, is annotated destructive.

The agent is configured with require_approval_for_tools: ["@destructive"], and TrueForge
resolves that selector from those annotations.

That is the whole design, and it is the reason we used TrueForge rather than wiring tools
to a model ourselves. The human gate is a property of the tool manifest, not of our
control flow. There is no "if approved" branch anywhere that someone could delete, and a
dangerous tool added later is gated automatically as long as it is annotated honestly.

We ran it and recorded what happened, in docs/trueforge-run.md rather than claiming it:

  TURN 1  "scan, verify, assess, plan"        five tool calls, completed unattended
  TURN 2  "Revoke the live credential now."   tool.approval_required, turn paused

Nothing in the prompt produced that stop. The agent reached for a destructive tool and
the harness refused to hand it over. Resuming with a denial, the agent reported the
refusal and reasoned about rotation rather than retrying. The credential was checked
afterwards and still worked.

We also hit a bug in TrueForge along the way: v0.1.4 does not start on Windows at all. It
loads migrations through Kysely's FileMigrationProvider, which calls await import() on an
absolute path, and Node's ESM loader reads the drive letter as a URL scheme. We traced it,
wrote the one-line fix, and wired it into postinstall. It is worth reporting upstream.
```

## How did you use Qodo in your project?

```
Every pull request went through Qodo before merge. Across 14 PRs it surfaced 62 findings,
and they were not cosmetic. Several contradicted claims our own README was making.

Three that mattered:

The scanner reported "no secrets found" when it crashed. Any unreadable report, from a
permissions error to a disk fault, was silently converted into an empty finding list. For
a security tool that is the worst possible failure mode, because it looks exactly like a
clean bill of health. Qodo caught it, we verified the claim against the real scanner, and
it now refuses to report a result it is not sure of.

The sandbox could be walked around. The egress guard read only the first argument's host
field, so net.connect(port, host) went unchecked, and connecting to a literal IP address
skipped the DNS hook entirely. Our "network restricted to the provider endpoint" claim was
false until this was fixed.

The approval gate could be skipped. /api/approve did not require a plan to exist, so a
caller could scan, approve and revoke while never verifying the credential or seeing its
blast radius. The human decision would have been made blind, which defeats the entire
point of having one.

Qodo also caught two regressions we introduced while fixing its earlier findings, which
was the most useful part. In one, making an approval token optional let any local caller
revoke a credential with no human decision at all: worse than the bug it replaced. In
another, we claimed a race condition was fixed when the edit had not actually applied, and
only the unused variable had landed. There was no test, so nothing else would have caught
it.

All 62 findings are resolved or explicitly dismissed with reasons in the README, under
"Qodo Code Review Evidence".
```

## Blog link

Only if you write one. See below.

---

## The video, 3 minutes

The form requires it. Record the terminal, not the browser: the gate reads better there.

**Setup before recording:**

```bash
npm run fixtures
npm run demo:dry
```

Check the first finding says LIVE. Rehearse on `demo:dry` as many times as you like.
Record the real one with `npm run demo`. It only works once, because the revoke is
permanent.

### 0:00 to 0:25, the problem

> A credential gets committed to a repo. Someone has to find out whether it still works,
> what it can reach, and whether killing it breaks production. That takes hours, so it
> gets put off, and the key stays live.
>
> You could automate it, but the same agent that investigates could revoke a key
> production depends on. So nobody does.
>
> ContAIn splits those apart. The agent earns information, not permissions.

### 0:25 to 0:50, architecture

> Five tools published as an MCP server. Four are annotated read-only. One,
> revoke_credential, is annotated destructive. TrueForge is configured to require
> approval for anything destructive and resolves that from the annotations.
>
> So the gate is in the tool manifest, not in our code. There is no "if approved" branch
> to delete.

Show the server startup output while saying this. It prints the boundary.

### 0:50 to 2:10, the demo

Run it. Talk over each step.

At the scan: *"Three credentials. This one was committed and deleted two commits later,
so it is nowhere in the current code. Only a full history scan finds it, and that is what
most real leaks look like."*

At verification: *"Each one goes into a sandbox that can only reach GitHub. Two are dead.
One is not."*

At the blast radius, read it off the screen: *"Anyone holding this key can administer the
enterprise account, administer organisations, and permanently delete repositories."*

Then: *"That is the difference between a scanner and something useful. A scanner tells you
a string looks like a token. This tells you what it opens."*

**At the gate, pause. Let it sit.**

> This is the point. The agent has done everything it can do on its own, and it has
> stopped. It cannot revoke this key.

Type `revoke`.

> Now it fires. And notice it does not just tell you it worked. GitHub returns 202 for
> any token, including one that never existed, so that response proves nothing. The agent
> goes back and checks. It only reports the key dead once it has watched the door close.

### 2:10 to 2:40, Qodo

> Every pull request went through Qodo. 62 findings across 14 PRs. It caught the scanner
> reporting "no secrets found" when it crashed, a way to walk around the sandbox, and a
> path where the human approval could be skipped entirely.
>
> It also caught two bugs I introduced while fixing its earlier findings.

### 2:40 to 3:00, close

> The agent earns information, not permissions. Everything up to the irreversible step
> runs unattended. The irreversible step needs a person, and that is enforced by the tool
> manifest rather than by asking the model nicely.

---

## The blog post

A whole prize track, and it is mostly written already. Pull from:

- `docs/phase-0.md` - the two go/no-go checks, and the discovery that GitHub returns 202
  for a credential that never existed, so the response is not evidence
- `docs/trueforge-run.md` - the Windows bug in TrueForge and how it was traced
- The README's Qodo section - the scanner that reported clean when it crashed

The strongest angle is what went wrong rather than what was built. Three honest stories:
a security tool whose worst failure mode was looking healthy, a sandbox that could be
walked around, and a fix that introduced something worse than the bug it replaced.
