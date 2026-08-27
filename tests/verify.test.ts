import { describe, expect, it } from "vitest";
import { describeGitHubBlastRadius } from "../src/templates/blast-radius.js";
import { allTemplates, templateForProvider } from "../src/templates/registry.js";
import { READ_ONLY_METHODS } from "../src/templates/types.js";
import type { SandboxExecutor, SandboxRequest, SandboxResult } from "../src/sandbox/types.js";
import { verifyAll, verifyFinding } from "../src/tools/verify.js";
import type { Finding } from "../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "abc123:deploy/staging.yml:github-pat:5",
    provider: "github",
    ruleId: "github-pat",
    secret: "ghp_stand_in_value_for_tests_only_000000",
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

/** A sandbox that returns a scripted result, so tests never touch the network. */
function stubSandbox(result: Partial<SandboxResult>): SandboxExecutor {
  return {
    kind: "local",
    async run(_request: SandboxRequest): Promise<SandboxResult> {
      return { ok: true, stderr: "", elapsedMs: 5, sandboxKind: "local", ...result };
    },
  };
}

describe("verification templates are read-only", () => {
  // The central safety property. Investigation runs without approval precisely
  // because it cannot change anything. A template that could write would collapse
  // the distinction the whole design rests on.
  it.each(allTemplates().map((t) => [t.id, t] as const))(
    "%s issues only read-only HTTP methods",
    (_id, template) => {
      const methods = [...template.source.matchAll(/method:\s*['"]([A-Z]+)['"]/g)].map((m) => m[1]);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect(READ_ONLY_METHODS).toContain(method);
      }
    },
  );

  it.each(allTemplates().map((t) => [t.id, t] as const))(
    "%s never names a mutating method",
    (_id, template) => {
      expect(template.source).not.toMatch(/['"](POST|PUT|PATCH|DELETE)['"]/);
    },
  );

  it.each(allTemplates().map((t) => [t.id, t] as const))(
    "%s declares an explicit host allowlist",
    (_id, template) => {
      expect(template.allowHosts.length).toBeGreaterThan(0);
      expect(template.timeoutMs).toBeGreaterThan(0);
    },
  );

  it("does not reach GitHub's revoke endpoint from any template", () => {
    for (const template of allTemplates()) {
      expect(template.source).not.toContain("credentials/revoke");
    }
  });
});

describe("verifyFinding", () => {
  it("classifies a working credential as LIVE and describes its reach", async () => {
    const sandbox = stubSandbox({
      value: {
        status: "LIVE",
        httpStatus: 200,
        principal: "Dank-Burner",
        capabilities: ["repo", "delete_repo", "admin:org", "gist"],
        facts: { publicRepos: 1, totalPrivateRepos: 4, twoFactorEnabled: false },
      },
    });

    const record = await verifyFinding(finding(), sandbox);

    expect(record.status).toBe("LIVE");
    expect(record.principal).toBe("Dank-Burner");
    expect(record.templateId).toBe("github.user.v1");
    expect(record.blastRadius.worstSeverity).toBe("critical");
    expect(record.blastRadius.headline).toContain("Dank-Burner");
    expect(record.blastRadius.reach).toContain("4 private repositories on this account");
  });

  it("classifies a rejected credential as DEAD with no blast radius", async () => {
    const sandbox = stubSandbox({ value: { status: "DEAD", httpStatus: 401 } });
    const record = await verifyFinding(finding(), sandbox);

    expect(record.status).toBe("DEAD");
    expect(record.blastRadius.capabilities).toEqual([]);
    expect(record.blastRadius.headline).toContain("grants nothing");
  });

  it("reports UNKNOWN rather than guessing when the provider is unclear", async () => {
    const sandbox = stubSandbox({ value: { status: "UNKNOWN", httpStatus: 503 } });
    const record = await verifyFinding(finding(), sandbox);
    expect(record.status).toBe("UNKNOWN");
  });

  it("reports UNKNOWN when no template covers the provider", async () => {
    const record = await verifyFinding(
      finding({ provider: "unknown" }),
      stubSandbox({ value: { status: "LIVE" } }),
    );

    expect(record.status).toBe("UNKNOWN");
    expect(record.templateId).toBeNull();
    expect(record.reason).toContain("No verification template");
  });

  it("survives a sandbox failure without stopping the run", async () => {
    // One unreachable provider must not prevent the other findings being triaged.
    const sandbox = stubSandbox({ ok: false, error: "Timed out after 20000ms", value: undefined });
    const record = await verifyFinding(finding(), sandbox);

    expect(record.status).toBe("UNKNOWN");
    expect(record.reason).toContain("Timed out");
  });

  it("rejects a template result that does not match the expected shape", async () => {
    const sandbox = stubSandbox({ value: { status: "PROBABLY_FINE" } });
    const record = await verifyFinding(finding(), sandbox);

    expect(record.status).toBe("UNKNOWN");
    expect(record.reason).toContain("unexpected shape");
  });

  it("only ever sends the template to its own declared hosts", async () => {
    let seen: SandboxRequest | undefined;
    const spy: SandboxExecutor = {
      kind: "local",
      async run(request) {
        seen = request;
        return { ok: true, value: { status: "DEAD" }, stderr: "", elapsedMs: 1, sandboxKind: "local" };
      },
    };

    await verifyFinding(finding(), spy);
    expect(seen?.allowHosts).toEqual(["api.github.com"]);
  });
});

describe("verifyAll", () => {
  it("returns one record per finding, in order", async () => {
    const sandbox = stubSandbox({ value: { status: "DEAD" } });
    const findings = [finding({ id: "one" }), finding({ id: "two" }), finding({ id: "three" })];
    const records = await verifyAll(findings, sandbox);
    expect(records.map((r) => r.findingId)).toEqual(["one", "two", "three"]);
  });
});

describe("blast radius wording", () => {
  it("leads with the worst capability", () => {
    const radius = describeGitHubBlastRadius({
      status: "LIVE",
      principal: "octo",
      capabilities: ["gist", "delete_repo", "notifications"],
      facts: {},
    });

    expect(radius.headline).toContain("permanently delete repositories");
    expect(radius.capabilities[0]?.scope).toBe("delete_repo");
  });

  it("treats an unrecognised scope as high rather than ignoring it", () => {
    const radius = describeGitHubBlastRadius({
      status: "LIVE",
      capabilities: ["some:future:scope"],
      facts: {},
    });

    expect(radius.worstSeverity).toBe("high");
    expect(radius.capabilities[0]?.plain).toContain("not in our catalogue");
  });

  it("says so when a fine-grained token hides its permissions", () => {
    const radius = describeGitHubBlastRadius({
      status: "LIVE",
      principal: "octo",
      capabilities: [],
      facts: { tokenKind: "fine-grained" },
    });

    expect(radius.headline).toContain("checking by hand");
  });
});

describe("registry", () => {
  it("resolves github and nothing it does not know", () => {
    expect(templateForProvider("github")?.id).toBe("github.user.v1");
    expect(templateForProvider("gitlab")).toBeUndefined();
  });
});
