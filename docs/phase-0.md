# Phase 0 - go/no-go findings

Two things could have sunk this project late. Both were checked before any feature code
was written. Both are green. The checks turned up four constraints that shaped the design.

## 1. Revoke path - GREEN

`POST https://api.github.com/credentials/revoke`, unauthenticated, body
`{"credentials": [...]}`. Accepts `ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghr_`.
Limits: 60 unauthenticated requests/hour, 1000 tokens/request. No GitHub App required.

Verified from this machine using a deliberately fake token, which revoked nothing:

| Check | Result |
| --- | --- |
| Unauthenticated POST, fake token | `202 Accepted`, empty body |
| Same POST with an `Authorization` header | `401` - rejected |
| `GET /user` with a dead token | `401` - our DEAD signal |
| `X-OAuth-Scopes` on a live response | exposed - our blast-radius signal |

### Constraint 1 - the revoke tool must send no `Authorization` header

The docs say authenticated requests return `403`; in practice a bad token returns `401`.
Either way, authenticating breaks revocation. Non-obvious, and easy to reintroduce by
sharing an HTTP client with the verification code. Covered by its own test.

### Constraint 2 - the `202` proves nothing

GitHub returns `202` unconditionally and revokes asynchronously. Our fake token got the
same response a real credential would. The audit trail therefore never records "revoked"
on the strength of the status code; it records the result of a re-run verification.

### Verified against a real credential

The checks above used a fake token. The path was later confirmed end to end against a
genuine classic PAT on the throwaway account, with a second live token on the *same*
account held as a control:

    BEFORE  tokenB=200  tokenA=200
    revoke call -> http=202
    poll 1: tokenB=401 -> REVOKED
    AFTER   tokenB=401  tokenA=200

Three things this establishes:

- Revocation is real and effectively immediate. Despite the asynchronous `202`, the
  token was already dead on the first re-check.
- **Revocation is scoped to the credential, not the account.** Token A survived
  untouched despite sharing an account and an identical scope set with token B. The
  agent kills one key, not the user.
- The re-verification pattern works as designed. We observed the flip to `401` rather
  than trusting the `202`, which is exactly what the audit trail will record.

### Constraint 3 - the endpoint is unauthenticated, global, and irreversible

It accepts any token from anyone, and GitHub cannot reactivate a revoked credential.
Nothing about the endpoint stops us revoking an unrelated third party's key. That is
enforced on our side instead: a token is only eligible for revocation if its exact value
appeared in this run's findings, was verified LIVE, and is covered by the approval.

## 2. Sandbox - GREEN

No Docker, WSL, or podman on the build machine, and TrueForge supports exactly one
sandbox provider (Daytona, cloud, API key). A restricted-subprocess prototype was built
and exercised:

    1) hello-world in sandbox:      {'result': {'hello': 'ContAIn'}, 'exit_code': 0}
    2) read-only GitHub verify:     {'status': 'DEAD', 'http': 401}   <- real API call
    3) exfiltration to example.com: BLOCKED - DNS blocked, allowlist=['api.github.com']
    4) 30s sleep, 3s timeout:       TIMEOUT at 3.0s

Clean environment, own working directory, wall-clock timeout, captured output,
writes blocked outside the sandbox root, egress restricted to a pre-resolved allowlist.

### Constraint 4 - TrueForge does not expose Daytona's firewall

Daytona itself supports `domainAllowList`, `networkAllowList`, and `networkBlockAll`,
which would give kernel-level egress control. But TrueForge's entire
`SandboxProviderManifest` is `type`, `auth.api_key`, `exec_timeout_ms`, and three
lifecycle intervals, with `additionalProperties: false` and no network field. The
per-agent `SandboxConfig` is only `{enabled, file_downloads}`. A sandbox provisioned
through TrueForge cannot be given an egress allowlist.

Daytona also only honours per-sandbox allowlists on Tier 3/4; on Tier 1/2 the
organisation policy wins regardless.

**Decision:** keep TrueForge provisioning the sandbox and enforce the allowlist inside
it, using the guard proven above ported to Node. This works on any Daytona tier, keeps
the sandbox visibly the harness's own (`sandbox.created` appears in the turn stream),
and costs us kernel-level enforcement - which the README states plainly rather than
glossing over.

## Harness findings

`require_approval_for_tools` defaults to `["@write", "@destructive"]`, and those
selectors resolve from the MCP tool annotations the tool server publishes. The gate is
therefore declarative: annotate the revoke tool destructive and TrueForge stops the turn
on it. Mechanically, a gated call emits `tool.approval_required`, the turn ends paused
with `state.requiredActions`, and it resumes on a new turn carrying
`user.tool_approval` with `{status: 'allow' | 'deny', reason}`.

Versions confirmed live: `@truefoundry/trueforge@0.1.4`, `@truefoundry/trueforge-sdk@0.1.3`,
`@truefoundry/trueforge-ui@0.2.4`, `@daytona/sdk@0.207.0`, Node >= 22.

## Sources

- https://docs.github.com/en/rest/credentials/revoke
- https://trueforge.dev/llms.txt (doc index), `/sandbox`, `/create-agent/overview`, `/api/use-agent`
- https://trueforge.dev/openapi.json
- https://www.daytona.io/docs/en/network-limits.md
- https://qodo-merge-docs.qodo.ai/installation/github/
