import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalError, ApprovalRegistry, fingerprint } from "../src/policy/approval.js";
import type { SandboxExecutor, SandboxResult } from "../src/sandbox/types.js";
import { GITHUB_REVOKE_URL, revokeCredential, type RevokePoster } from "../src/tools/revoke.js";
import type { Finding } from "../src/types.js";

const LIVE_SECRET = "ghp_test_live_value_aaaaaaaaaaaaaaaaaaaa";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "commit1:deploy/staging.yml:github-pat:5",
    provider: "github",
    ruleId: "github-pat",
    secret: LIVE_SECRET,
    file: "deploy/staging.yml",
    startLine: 5,
    commit: "a".repeat(40),
    author: "Priya Raman",
    email: "priya@leaky-service.example",
    date: "2026-01-14T16:41:00Z",
    commitMessage: "Add deploy config for staging",
    ...overrides,
  };
}

/** Sandbox that reports whatever status the re-verification should see. */
function sandboxReporting(status: "LIVE" | "DEAD"): SandboxExecutor {
  return {
    kind: "local",
    async run(): Promise<SandboxResult> {
      return {
        ok: true,
        value: { status, httpStatus: status === "DEAD" ? 401 : 200, capabilities: [], facts: {} },
        stderr: "",
        elapsedMs: 3,
        sandboxKind: "local",
      };
    },
  };
}

let registry: ApprovalRegistry;
let post: ReturnType<typeof vi.fn> & RevokePoster;

beforeEach(() => {
  registry = new ApprovalRegistry();
  post = vi.fn(async () => ({ status: 202 })) as never;
});

describe("revoke is unreachable without approval", () => {
  it("refuses with no approval token, and sends nothing", async () => {
    await expect(
      revokeCredential({
        finding: finding(),
        statusBefore: "LIVE",
        approvalToken: undefined,
        registry,
        sandbox: sandboxReporting("DEAD"),
        post,
      }),
    ).rejects.toThrow(/Human approval required/);

    expect(post).not.toHaveBeenCalled();
  });

  it("refuses an unrecognised token, and sends nothing", async () => {
    await expect(
      revokeCredential({
        finding: finding(),
        statusBefore: "LIVE",
        approvalToken: "not-a-real-token",
        registry,
        sandbox: sandboxReporting("DEAD"),
        post,
      }),
    ).rejects.toThrow(/not recognised/);

    expect(post).not.toHaveBeenCalled();
  });

  it("refuses when the human denied it", async () => {
    const grant = registry.grant({
      findingId: finding().id,
      secret: LIVE_SECRET,
      decision: "deny",
      grantedBy: "deep",
      reason: "staging deploy depends on it",
    });

    await expect(
      revokeCredential({
        finding: finding(),
        statusBefore: "LIVE",
        approvalToken: grant.token,
        registry,
        sandbox: sandboxReporting("DEAD"),
        post,
      }),
    ).rejects.toThrow(/denied/);

    expect(post).not.toHaveBeenCalled();
  });
});

describe("approval is bound to one specific credential", () => {
  it("refuses an approval issued for a different finding", async () => {
    // GitHub's revoke endpoint will destroy any token submitted to it, so an
    // approval that is not bound to a credential is not a control at all.
    const grant = registry.grant({
      findingId: "some-other-finding",
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });

    await expect(
      revokeCredential({
        finding: finding(),
        statusBefore: "LIVE",
        approvalToken: grant.token,
        registry,
        sandbox: sandboxReporting("DEAD"),
        post,
      }),
    ).rejects.toThrow(/covers finding some-other-finding/);

    expect(post).not.toHaveBeenCalled();
  });

  it("refuses when the credential value differs from the approved one", async () => {
    const grant = registry.grant({
      findingId: finding().id,
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });

    await expect(
      revokeCredential({
        finding: finding({ secret: "ghp_a_completely_different_token_00000000" }),
        statusBefore: "LIVE",
        approvalToken: grant.token,
        registry,
        sandbox: sandboxReporting("DEAD"),
        post,
      }),
    ).rejects.toThrow(/does not cover this credential/);

    expect(post).not.toHaveBeenCalled();
  });

  it("stores a digest of the credential, never the credential", () => {
    const grant = registry.grant({
      findingId: finding().id,
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });

    expect(grant.secretFingerprint).toBe(fingerprint(LIVE_SECRET));
    expect(JSON.stringify(grant)).not.toContain(LIVE_SECRET);
  });
});

describe("revoke with a valid approval", () => {
  function allow() {
    return registry.grant({
      findingId: finding().id,
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });
  }

  it("fires once and confirms the credential stopped working", async () => {
    const record = await revokeCredential({
      finding: finding(),
      statusBefore: "LIVE",
      approvalToken: allow().token,
      registry,
      sandbox: sandboxReporting("DEAD"),
      post,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(record.attempted).toBe(true);
    expect(record.httpStatus).toBe(202);
    expect(record.statusAfter).toBe("DEAD");
    expect(record.confirmed).toBe(true);
  });

  it("sends no Authorization header", async () => {
    // GitHub rejects authenticated calls to this endpoint. Easy to reintroduce by
    // sharing an HTTP client with the verification path, so it is pinned here.
    await revokeCredential({
      finding: finding(),
      statusBefore: "LIVE",
      approvalToken: allow().token,
      registry,
      sandbox: sandboxReporting("DEAD"),
      post,
    });

    const call = post.mock.calls[0]!;
    const url = call[0] as string;
    const body = call[1] as unknown;
    const headers = call[2] as Record<string, string>;

    expect(url).toBe(GITHUB_REVOKE_URL);
    expect(body).toEqual({ credentials: [LIVE_SECRET] });
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("does not claim success when the credential still authenticates", async () => {
    // The 202 is returned unconditionally, so it is not evidence. Only the
    // re-verification decides.
    const record = await revokeCredential({
      finding: finding(),
      statusBefore: "LIVE",
      approvalToken: allow().token,
      registry,
      sandbox: sandboxReporting("LIVE"),
      post,
    });

    expect(record.httpStatus).toBe(202);
    expect(record.confirmed).toBe(false);
    expect(record.note).toContain("Do not treat this as revoked");
  });

  it("does not report an unaccepted request as an attempt that worked", async () => {
    // 202 is the documented acceptance. A 422 or a 500 means nothing was revoked, and
    // saying otherwise would overstate what happened.
    post = vi.fn(async () => ({ status: 422 })) as never;
    const record = await revokeCredential({
      finding: finding(),
      statusBefore: "LIVE",
      approvalToken: allow().token,
      registry,
      sandbox: sandboxReporting("LIVE"),
      post,
    });

    expect(record.confirmed).toBe(false);
    expect(record.note).toContain("did not accept");
    expect(record.note).toContain("422");
  });

  it("does not claim confirmation without a transition to observe", async () => {
    // The credential was already dead before the call, so a dead reading afterwards
    // is not evidence that this request did anything.
    const record = await revokeCredential({
      finding: finding(),
      statusBefore: "UNKNOWN",
      approvalToken: allow().token,
      registry,
      sandbox: sandboxReporting("DEAD"),
      post,
    });

    expect(record.statusAfter).toBe("DEAD");
    expect(record.confirmed).toBe(false);
    expect(record.note).toContain("no transition to observe");
  });

  it("is idempotent: a retry does not fire a second time", async () => {
    const token = allow().token;
    const args = {
      finding: finding(),
      statusBefore: "LIVE" as const,
      approvalToken: token,
      registry,
      sandbox: sandboxReporting("DEAD"),
      post,
    };

    const first = await revokeCredential(args);
    const second = await revokeCredential(args);
    const third = await revokeCredential(args);

    expect(post).toHaveBeenCalledTimes(1);
    expect(first.confirmed).toBe(true);
    expect(second.attempted).toBe(false);
    expect(second.note).toContain("Already revoked");
    expect(third.attempted).toBe(false);
  });
});

describe("concurrent use of one approval", () => {
  it("fires once when two revocations race on the same token", async () => {
    // Checking "already spent" and then acting are two steps with an await between
    // them, so both callers used to pass the check and both fired an irreversible
    // request.
    const registry2 = new ApprovalRegistry();
    const grant = registry2.grant({
      findingId: finding().id,
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });
    const slowPost = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { status: 202 };
    });

    const args = {
      finding: finding(),
      statusBefore: "LIVE" as const,
      approvalToken: grant.token,
      registry: registry2,
      sandbox: sandboxReporting("DEAD"),
      post: slowPost as never,
    };

    const results = await Promise.allSettled([
      revokeCredential(args),
      revokeCredential(args),
      revokeCredential(args),
    ]);

    expect(slowPost).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("releases the approval when the request never landed", async () => {
    // A failed request has not spent the approval, so a retry should not need a
    // fresh human decision.
    const registry2 = new ApprovalRegistry();
    const grant = registry2.grant({
      findingId: finding().id,
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });
    const failing = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const args = {
      finding: finding(),
      statusBefore: "LIVE" as const,
      approvalToken: grant.token,
      registry: registry2,
      sandbox: sandboxReporting("DEAD"),
    };

    await expect(revokeCredential({ ...args, post: failing as never })).rejects.toThrow(
      /ECONNRESET/,
    );

    const retry = await revokeCredential({ ...args, post: post as never });
    expect(retry.attempted).toBe(true);
  });
});

describe("dry run", () => {
  it("never sends a request", async () => {
    // Replay runs in dry-run mode. Replaying a past run must not destroy a
    // credential a second time.
    const grant = registry.grant({
      findingId: finding().id,
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });

    const record = await revokeCredential({
      finding: finding(),
      statusBefore: "LIVE",
      approvalToken: grant.token,
      registry,
      sandbox: sandboxReporting("DEAD"),
      dryRun: true,
      post,
    });

    expect(post).not.toHaveBeenCalled();
    expect(record.attempted).toBe(false);
    expect(record.dryRun).toBe(true);
    expect(record.confirmed).toBe(false);
  });
});

describe("non-github providers", () => {
  it("has no revoke tool and says so", async () => {
    const f = finding({ provider: "gitlab" });
    const grant = registry.grant({
      findingId: f.id,
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });

    await expect(
      revokeCredential({
        finding: f,
        statusBefore: "LIVE",
        approvalToken: grant.token,
        registry,
        sandbox: sandboxReporting("DEAD"),
        post,
      }),
    ).rejects.toBeInstanceOf(ApprovalError);

    expect(post).not.toHaveBeenCalled();
  });
});
