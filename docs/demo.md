# Demo script

Two to three minutes. The whole demo is built around one moment: the agent stopping.
Everything before it exists to make that stop mean something, so do not rush to get there.

## Before you start

```bash
npm install
npm run fixtures      # rebuilds the demo repository
npm run ui:build
```

Have two terminal windows and a browser ready. Check the live credential still works:

```bash
npm run demo:dry
```

If the first finding says `LIVE`, you are ready. If it says `DEAD`, the token was revoked
at some point and you need a fresh one from the throwaway account.

**Do not run the real demo twice.** The revoke is permanent, so the live credential only
works once. Rehearse with `npm run demo:dry`, which never fires.

---

## The 20 second opening

> A credential gets committed to a repo. Someone has to find out whether it still works,
> what it can reach, and whether killing it breaks production. That takes hours, so it
> gets put off, and the key stays live.
>
> You could automate it. But the same agent that investigates could revoke a key
> production depends on. So nobody does.
>
> ContAIn splits those two things. The agent earns information, not permissions.

---

## Run it

```bash
npm run demo
```

### Step 1, the scan

Three credentials found. Point at the first one:

> This one is the interesting case. It was committed, then deleted two commits later. It
> is nowhere in the current code. Only a scan of full git history finds it, and that is
> what most real leaks look like.

Worth saying: this is gitleaks, the standard tool. We did not write a scanner.

### Step 2, verification

Each credential goes into a sandbox with its network restricted to GitHub and nothing
else. Point at the output as it appears:

> Two of these are dead. One is not.

### Step 3, blast radius

This is the part people remember. Read the sentence off the screen:

> Live on the account Dank-Burner. Anyone holding this key can administer the enterprise
> account, administer organisations, including who belongs to them, and permanently
> delete repositories. Plus 18 further permissions.

Then:

> That is the difference between a scanner and something useful. A scanner tells you a
> string looks like a token. This tells you what it opens.

### Step 4, the stop

**Pause here. Let the panel sit on screen.**

> This is the whole point. The agent has done everything it can do on its own, and it has
> stopped. It cannot revoke this key. Not because we asked it nicely in a prompt, but
> because the revoke tool is annotated destructive, and the harness will not hand it over
> without a human.

If someone asks how it is enforced:

> Every tool publishes an annotation saying what it does to the world. Four are read-only.
> One is destructive. TrueForge is configured to require approval for anything destructive
> and resolves that from the annotations. There is no `if approved` branch to delete. Add
> a new dangerous tool and it is gated automatically.

### Step 5, approve

Type `revoke` and press enter.

> Now it fires. One real API call to GitHub.

### Step 6, proof

> Notice it does not just tell you it worked. GitHub returns 202 Accepted for any token,
> including one that never existed, so that response proves nothing. The agent goes back
> and checks. It only reports the key as dead once it has watched the door close.

### Step 7, the audit trail

> Every finding, every verification, every decision, and what was actually done.
> Credentials masked throughout. If someone asks in six months why this key was destroyed,
> the answer is here.

---

## If you have another 30 seconds

```bash
npm run demo:dry
```

> Same repository, same findings, same classifications, same plan. Reproducible. Without
> that, an audit trail is a story rather than a record.

---

## The visual version

If you would rather present in a browser than a terminal:

```bash
npm run ui
```

Open `http://localhost:8910` and press the three buttons in order. The stage rail across
the top labels every step either AUTOMATIC or STOPS HERE, which makes the argument before
anyone reads a finding.

Same warning applies: approving in the UI performs a real revocation.

---

## Questions you will probably get

**"Isn't this just a secret scanner?"**
Scanning is the first of seven steps and we did not write it. The work is everything after:
proving whether a key is live, working out what it opens, and revoking it safely.

**"What stops the agent revoking something on its own?"**
The revoke tool is annotated destructive, and the harness will not call a destructive tool
without human approval. Separately, the approval carries a digest of the specific
credential it covers, so an approval for one key cannot be used on another.

**"Could the model be talked into bypassing it?"**
The instructions explain the boundary, they do not enforce it. If the model ignored every
word, the boundary would still hold, because it is in the tool manifest and in the
approval registry rather than in the prompt.

**"How do you know the sandbox is actually contained?"**
There are tests for it: an allowlisted host is reachable, anything else is refused, an
empty allowlist blocks everything, an overrunning template is killed, and the host
environment is not inherited. We are also explicit in the README that it is a strong
boundary rather than a jail, because the templates are fixed and reviewed rather than
model-written.

**"What if the revoke call fails silently?"**
That is exactly why we re-verify instead of trusting the response. If the credential still
authenticates afterwards, the record says so rather than claiming success.
