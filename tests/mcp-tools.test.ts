import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxExecutor, SandboxResult } from "../src/sandbox/types.js";
import { RunState } from "../src/mcp/state.js";
import {
  TOOLS,
  destructiveToolNames,
  readOnlyToolNames,
  type ToolDeps,
} from "../src/mcp/tools.js";
import type { Finding } from "../src/types.js";

const LIVE_SECRET = "ghp_live_test_value_bbbbbbbbbbbbbbbbbbbb";

function finding(id = "f1"): Finding {
  return {
    id,
    provider: "github",
    ruleId: "github-pat",
    secret: LIVE_SECRET,
    file: "deploy/staging.yml",
    startLine: 5,
    commit: "b".repeat(40),
    author: "Priya Raman",
    email: "priya@leaky-service.example",
    date: "2026-01-14T16:41:00Z",
    commitMessage: "Add deploy config for staging",
  };
}

function sandboxReporting(status: "LIVE" | "DEAD"): SandboxExecutor {
  return {
    kind: "local",
    async run(): Promise<SandboxResult> {
      return {
        ok: true,
        value: {
          status,
          httpStatus: status === "LIVE" ? 200 : 401,
          principal: "Dank-Burner",
          capabilities: status === "LIVE" ? ["repo", "delete_repo"] : [],
          facts: {},
        },
        stderr: "",
        elapsedMs: 4,
        sandboxKind: "local",
      };
    },
  };
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

let state: RunState;
let deps: ToolDeps;
let post: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state = new RunState();
  post = vi.fn(async () => ({ status: 202 }));
  deps = {
    state,
    sandbox: sandboxReporting("DEAD"),
    operator: "deep",
    dryRun: false,
    post: post as never,
  };
  state.setFindings("fixtures/leaky-service", [finding()]);
});

describe("the annotation contract", () => {
  // These tests are the thesis. The gate is a property of the tool manifest, so if
  // the manifest drifts, the gate drifts with it and these must fail.

  it("marks exactly one tool destructive, and it is the revoke tool", () => {
    expect(destructiveToolNames()).toEqual(["revoke_credential"]);
  });

  it("marks every investigative tool read-only", () => {
    expect(readOnlyToolNames().sort()).toEqual(
      ["build_remediation_plan", "read_audit_trail", "scan_repository", "verify_credential"].sort(),
    );
  });

  it("never marks a tool both read-only and destructive", () => {
    for (const t of TOOLS) {
      expect(t.annotations.readOnlyHint === true && t.annotations.destructiveHint === true).toBe(
        false,
      );
    }
  });

  it("gives every tool an explicit annotation rather than relying on a default", () => {
    // An unannotated tool would not be caught by the "@destructive" selector, so
    // silence here would mean an ungated tool.
    for (const t of TOOLS) {
      expect(t.annotations.readOnlyHint).toBeTypeOf("boolean");
      expect(t.annotations.destructiveHint).toBeTypeOf("boolean");
    }
  });

  it("declares the destructive tool idempotent, because retrying must not fire twice", () => {
    expect(tool("revoke_credential").annotations.idempotentHint).toBe(true);
  });

  it("describes the destructive tool in terms a human can act on", () => {
    // This description is what a person reads at the approval prompt.
    const description = tool("revoke_credential").description;
    expect(description).toContain("cannot be undone");
    expect(description).toContain("Requires an approval");
  });
});

describe("tools never return a credential", () => {
  it("masks secrets in verification output", async () => {
    const result = await tool("verify_credential").handler({ findingId: "f1" }, deps);
    expect(JSON.stringify(result)).not.toContain(LIVE_SECRET);
  });

  it("masks secrets in the plan", async () => {
    await tool("verify_credential").handler({ findingId: "f1" }, deps);
    const plan = await tool("build_remediation_plan").handler({}, deps);
    expect(JSON.stringify(plan)).not.toContain(LIVE_SECRET);
  });

  it("masks secrets in the audit trail", async () => {
    await tool("verify_credential").handler({ findingId: "f1" }, deps);
    const trail = await tool("read_audit_trail").handler({}, deps);
    expect(JSON.stringify(trail)).not.toContain(LIVE_SECRET);
  });
});

describe("the destructive tool refuses without approval", () => {
  it("throws and sends nothing when the approval token is unknown", async () => {
    await expect(
      tool("revoke_credential").handler({ findingId: "f1", approvalToken: "made-up" }, deps),
    ).rejects.toThrow(/not recognised/);

    expect(post).not.toHaveBeenCalled();
  });

  it("records the refusal, so the trail shows the agent was stopped", async () => {
    await expect(
      tool("revoke_credential").handler({ findingId: "f1", approvalToken: "made-up" }, deps),
    ).rejects.toThrow();

    const refusals = state.audit.events().filter((e) => e.type === "action.refused");
    expect(refusals).toHaveLength(1);
  });

  it("fires exactly once with a valid approval, and confirms the transition", async () => {
    // Verify first so there is a LIVE reading to transition away from. Without one,
    // a later DEAD reading is not evidence the revoke did anything.
    deps.sandbox = sandboxReporting("LIVE");
    await tool("verify_credential").handler({ findingId: "f1" }, deps);
    deps.sandbox = sandboxReporting("DEAD");

    const grant = state.approvals.grant({
      findingId: "f1",
      secret: LIVE_SECRET,
      decision: "allow",
      grantedBy: "deep",
    });

    const record = await tool("revoke_credential").handler(
      { findingId: "f1", approvalToken: grant.token },
      deps,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({
      attempted: true,
      confirmed: true,
      statusBefore: "LIVE",
      statusAfter: "DEAD",
    });
  });

  it("works under a harness that gates the tool itself, with no token supplied", async () => {
    // Nothing on the harness path issues our token: the harness's own approval is what
    // let the call through. Requiring a token here refused every approved revocation.
    deps.sandbox = sandboxReporting("LIVE");
    await tool("verify_credential").handler({ findingId: "f1" }, deps);
    deps.sandbox = sandboxReporting("DEAD");

    const record = (await tool("revoke_credential").handler({ findingId: "f1" }, deps)) as {
      attempted: boolean;
      approvedBy: string;
    };

    expect(post).toHaveBeenCalledTimes(1);
    expect(record.attempted).toBe(true);
    expect(record.approvedBy).toContain("harness tool approval");
  });
});

describe("the investigative loop", () => {
  it("verifies, plans, and reaches the gate without any approval", async () => {
    // The whole point: everything up to the destructive step runs unattended.
    deps.sandbox = sandboxReporting("LIVE");

    const verification = (await tool("verify_credential").handler({ findingId: "f1" }, deps)) as {
      status: string;
      blastRadius: { headline: string };
    };
    expect(verification.status).toBe("LIVE");
    expect(verification.blastRadius.headline).toContain("Dank-Burner");

    const plan = (await tool("build_remediation_plan").handler({}, deps)) as {
      items: { action: string; requiresApproval: boolean }[];
      summary: { awaitingApproval: number };
    };

    expect(plan.items[0]?.action).toBe("revoke_and_rotate");
    expect(plan.items[0]?.requiresApproval).toBe(true);
    expect(plan.summary.awaitingApproval).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });
});
