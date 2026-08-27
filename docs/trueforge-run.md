# Running inside TrueForge: what was actually observed

This records a real run of ContAIn as a TrueForge agent, rather than a claim that it
would work. Reproduce it with the scripts in `scripts/`.

## Setup

- TrueForge v0.1.4, standalone mode, SQLite, on `http://localhost:8790`
- Model: `google-gemini/gemini-2.5-flash`
- MCP server: ContAIn on `http://localhost:8900/mcp`, registered as a remote connector
- Agent created over the API, because `require_approval_for_tools` cannot be set in the UI

## TrueForge reads our annotations

`GET /api/v1/mcp-servers/contain/tools`:

```
scan_repository          read-only
verify_credential        read-only
build_remediation_plan   read-only
read_audit_trail         read-only
revoke_credential        DESTRUCTIVE
```

This is the load-bearing part. The agent is configured with
`require_approval_for_tools: ["@destructive"]`, and the harness resolves that selector
against exactly this list.

## Turn 1: investigation runs unattended

> Scan the repository at fixtures/leaky-service, verify every credential you find, assess
> the blast radius of any live one, and build the remediation plan. Do not revoke anything.

Completed with no interruption. The agent reported:

> **1 LIVE credential (requires human approval for revocation)**
> **2 DEAD credentials (can be stripped from history)**
>
> Blast Radius: Live on the account "Dank-Burner". Anyone holding this key can administer
> the enterprise account, administer organizations, including who belongs to them, and
> permanently delete repositories. Plus 18 further permissions.

Four tools ran without anyone being asked for anything, because all four are read-only.

## Turn 2: the destructive action stops

> Revoke the live credential now.

The turn ended paused. The harness recorded:

```json
{
  "type": "tool.approval_required",
  "id": "01m11apnjsfwhwtqnkqg8gphj6",
  "created_at": "2026-08-27T10:02:00.153Z",
  "thread_id": "main",
  "tool_calls": [
    { "id": "aJRu4yh8Eh2acYIX", "source_event_id": "01m11apaer052kj7h60fs207ta" }
  ]
}
```

The pending call is `revoke_credential`, with the finding id it wants to act on visible to
whoever decides:

```
{"findingId":"79783f1cef100fde1233c1d7c364f6927c0a9239:deploy/staging.yml:github-pat:5"}
```

Nothing in the prompt produced this. The agent asked for a tool, the tool is annotated
destructive, and the harness stopped.

## Turn 3: the denial is honoured

Resumed with `user.tool_approval`, `{ "status": "deny", "reason": "Staging deploy still
uses this key. Rotating first." }`. The agent reported the refusal and reasoned about it
rather than retrying or failing:

> I was unable to revoke the live credential. The system reported: "Staging deploy still
> uses this key. Rotating first." [...] You will need to address the active usage of the
> credential in the staging deploy and rotate it before I can attempt to revoke it again.

The credential was verified afterwards and still returns `200`. Nothing was destroyed.

## Reproducing it

```bash
npm run mcp                                   # terminal 1
npx @truefoundry/trueforge@latest             # terminal 2
node scripts/create-trueforge-agent.mjs       # after connecting Gemini and the MCP server
node scripts/run-trueforge-demo.mjs
node scripts/trueforge-deny.mjs <sessionId>
```

Full setup steps are in [`trueforge-setup.md`](trueforge-setup.md).

## One patch was needed to run TrueForge on Windows

TrueForge v0.1.4 does not start on Windows. It uses Kysely's `FileMigrationProvider` to
load migrations, and that provider calls `await import(filePath)` with an absolute path.
Node's ESM loader rejects a Windows absolute path, because it parses the drive letter as a
URL scheme:

```
Failed to start server: Only URLs with a scheme in: file, data, and node are supported
by the default ESM loader. On Windows, absolute paths must be valid file:// URLs.
Received protocol 'e:'
```

The one-line fix is in Kysely rather than TrueForge: wrap the path in `pathToFileURL`
before importing it. `scripts/patch-kysely-windows.mjs` applies it, and `npm run setup`
runs it. Not needed on macOS or Linux, where the same code path works as written.

Worth reporting upstream to both projects.
