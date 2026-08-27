# Running ContAIn inside TrueForge

The remaining piece. Everything else is built and tested; this connects it to the harness
and demonstrates the gate firing inside TrueForge rather than only in our own CLI.

Roughly 20 minutes. Both API keys are already in `.env`.

## What we are proving

That `require_approval_for_tools: ["@destructive"]` resolves from the annotations our MCP
server publishes, and that TrueForge halts the turn on `revoke_credential` and asks a
human. Until this is run, the honest claim is "built to plug into TrueForge and the
mechanism is tested", not "running in TrueForge".

## Step 1: start the ContAIn MCP server

In its own terminal, from the repo root:

```bash
npm run mcp
```

Expect:

```
ContAIn MCP server listening on http://localhost:8900/mcp
approval:  an approval token bound to the credential is required
tools:
  scan_repository          read-only
  verify_credential        read-only
  build_remediation_plan   read-only
  read_audit_trail         read-only
  revoke_credential        DESTRUCTIVE, needs approval
```

Leave it running.

## Step 2: start TrueForge

Second terminal:

```bash
npx @truefoundry/trueforge@latest
```

Local mode, SQLite, no login. It serves on `http://localhost:8790`.

## Step 3: connect Gemini

In the TrueForge UI, **Settings, Models**. Pick **Google Gemini** from the catalogue and
paste `GEMINI_API_KEY` from `.env`. Choose `gemini-2.5-flash`.

## Step 4: connect the MCP server

**Settings, Connectors** (also called MCP servers). Add a server:

- name: `contain`
- url: `http://localhost:8900/mcp`
- auth: none

Then list its tools and confirm five appear. This is the moment to check that
`revoke_credential` shows as destructive.

## Step 5: create the agent

The UI cannot set `require_approval_for_tools`; that field is API only. So create the
agent over the API, using the spec in `src/agent/spec.ts`:

```bash
curl -X POST http://localhost:8790/v1/agents \
  -H "content-type: application/json" \
  -d @- <<'JSON'
{
  "name": "contain",
  "model": { "name": "google-gemini/gemini-2.5-flash" },
  "instructions": "<paste INSTRUCTIONS from src/agent/spec.ts>",
  "mcp_servers": [
    {
      "name": "contain",
      "enable_tools": ["@all"],
      "require_approval_for_tools": ["@destructive"],
      "preload": true
    }
  ],
  "config": {
    "sandbox": { "enabled": false },
    "generative_ui": { "enabled": true },
    "ask_user_questions": { "enabled": true },
    "iteration_limit": 40
  }
}
JSON
```

Check the exact path against `https://trueforge.dev/api-reference/agents/create-an-agent`
before running it; do not guess it.

Note `sandbox.enabled: false`. Our verification runs its own sandbox inside the MCP tool,
so TrueForge does not need to provision one. Turn it on later only if adding Code Mode.

## Step 6: run it

Open a chat on the `contain` agent and send:

> Scan the repository at fixtures/leaky-service, verify every credential you find, and
> tell me what the live one can reach. Do not revoke anything yet.

Expected: it scans, verifies each finding, reports the blast radius on the live key, and
builds the plan. All of that runs unattended, because every tool involved is read-only.

Then:

> Revoke the live credential.

**This is the moment.** TrueForge should stop the turn and show an Allow / Deny prompt with
the tool arguments. That is `tool.approval_required`, resolved from the destructive
annotation. Screenshot this.

## Step 7: decide

Press **Deny** first and confirm the agent reports being refused rather than crashing.

Only press **Allow** when you are ready to spend a live token, because it revokes for real.

## If something does not work

**Tools do not appear.** TrueForge is a separate process reaching `localhost:8900`. Check
`npm run mcp` is still running and `curl http://localhost:8900/health` returns ok.

**No approval prompt appears.** The annotation is not being read. Check the tool list in
Settings shows `revoke_credential` as destructive, and that the agent was created via the
API with `require_approval_for_tools`, since the UI cannot set it.

**Revoke is refused even after pressing Allow.** Expected in the default configuration:
the MCP server requires an approval token bound to the credential, and TrueForge does not
issue one. Restart the server with the harness gate declared:

```bash
CONTAIN_HARNESS_GATES_DESTRUCTIVE=true npm run mcp
```

Only do this while TrueForge is the caller. It tells the server that a gating harness sits
in front, and setting it in any other deployment removes the gate.

## After it works

- Screenshot the approval prompt for the submission.
- Add a short section to the README showing it running in TrueForge.
- Update the claim from "built to plug into TrueForge" to what was actually observed.
