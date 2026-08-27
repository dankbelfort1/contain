import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/agent/plan.js";
import { AuditLeakError, AuditTrail, assertNoSecrets } from "../src/harness/audit.js";
import { DEFAULT_POLICY, ruleFor } from "../src/policy/rules.js";
import type { VerificationRecord } from "../src/tools/verify.js";
import type { Finding } from "../src/types.js";

const REAL_LOOKING_SECRET = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    provider: "github",
    ruleId: "github-pat",
    secret: REAL_LOOKING_SECRET,
    file: "deploy/staging.yml",
    startLine: 5,
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    author: "Priya Raman",
    email: "priya@leaky-service.example",
    date: "2026-01-14T16:41:00Z",
    commitMessage: "Add deploy config for staging",
    ...overrides,
  };
}

function record(findingId: string, status: "LIVE" | "DEAD" | "UNKNOWN"): VerificationRecord {
  return {
    findingId,
    provider: "github",
    templateId: "github.user.v1",
    status,
    capabilities: status === "LIVE" ? ["repo", "delete_repo"] : [],
    blastRadius: {
      headline: status === "LIVE" ? "Live on the account octo." : "Not live.",
      capabilities:
        status === "LIVE"
          ? [{ scope: "delete_repo", severity: "critical", plain: "permanently delete repositories" }]
          : [],
      reach: [],
      worstSeverity: status === "LIVE" ? "critical" : "low",
    },
    sandboxKind: "local",
    elapsedMs: 12,
  };
}

describe("policy", () => {
  it("requires approval for a live credential and nothing else", () => {
    expect(ruleFor("LIVE").requiresApproval).toBe(true);
    expect(ruleFor("DEAD").requiresApproval).toBe(false);
    expect(ruleFor("UNKNOWN").requiresApproval).toBe(false);
  });

  it("has no rule that produces an unapproved destructive action", () => {
    // The claim the project makes: there is no configuration in which the agent
    // revokes something on its own.
    for (const rule of DEFAULT_POLICY) {
      if (rule.action === "revoke_and_rotate") {
        expect(rule.requiresApproval).toBe(true);
      }
    }
  });

  it("gates a destructive action even when a policy says otherwise", () => {
    // A caller-supplied policy must not be able to remove the gate. This is the one
    // thing no configuration is allowed to do.
    const permissive = [
      {
        id: "reckless",
        when: "LIVE" as const,
        action: "revoke_and_rotate" as const,
        rationale: "kill it",
        requiresApproval: false,
      },
    ];
    const plan = buildPlan([finding("live-1")], [record("live-1", "LIVE")], permissive);
    expect(plan.items[0]?.action).toBe("revoke_and_rotate");
    expect(plan.items[0]?.requiresApproval).toBe(true);
  });

  it("falls back to manual review for an unmapped status, not to an action", () => {
    const fallback = ruleFor("LIVE", []);
    expect(fallback.action).toBe("manual_review");
    expect(fallback.requiresApproval).toBe(false);
  });
});

describe("buildPlan", () => {
  const findings = [finding("dead-1"), finding("live-1"), finding("unknown-1")];
  const records = [record("dead-1", "DEAD"), record("live-1", "LIVE"), record("unknown-1", "UNKNOWN")];

  it("puts the live credential first", () => {
    const plan = buildPlan(findings, records);
    expect(plan.items[0]?.findingId).toBe("live-1");
    expect(plan.items[0]?.status).toBe("LIVE");
  });

  it("assigns the right action to each status", () => {
    const plan = buildPlan(findings, records);
    const byId = new Map(plan.items.map((i) => [i.findingId, i]));

    expect(byId.get("live-1")?.action).toBe("revoke_and_rotate");
    expect(byId.get("dead-1")?.action).toBe("strip_from_history");
    expect(byId.get("unknown-1")?.action).toBe("manual_review");
  });

  it("gives every item a reason and the rule that produced it", () => {
    const plan = buildPlan(findings, records);
    for (const item of plan.items) {
      expect(item.reason.length).toBeGreaterThan(30);
      expect(item.ruleId).toBeTruthy();
      // Attribution belongs in the reason: deleting the file again will not help if
      // the credential is in history.
      expect(item.reason).toContain("Priya Raman");
    }
  });

  it("never exposes a raw credential in the plan", () => {
    const plan = buildPlan(findings, records);
    expect(JSON.stringify(plan)).not.toContain(REAL_LOOKING_SECRET);
    expect(plan.items[0]?.maskedSecret).toMatch(/^ghp_\*+6789$/);
  });

  it("summarises what needs a human", () => {
    const plan = buildPlan(findings, records);
    expect(plan.summary).toEqual({
      total: 3,
      live: 1,
      dead: 1,
      unknown: 1,
      awaitingApproval: 1,
      needsManualReview: 1,
    });
  });

  it("treats a finding with no verification record as unverified, not as safe", () => {
    const plan = buildPlan([finding("orphan")], []);
    expect(plan.items[0]?.status).toBe("UNVERIFIED");
    expect(plan.items[0]?.action).toBe("manual_review");
  });
});

describe("audit trail", () => {
  it("records findings with the credential masked", () => {
    const trail = new AuditTrail();
    trail.recordFinding(finding("f1"));

    const serialised = trail.toJSONL();
    expect(serialised).not.toContain(REAL_LOOKING_SECRET);
    expect(serialised).toContain("ghp_");
  });

  it("refuses to record an event containing a credential", () => {
    // The trail is the artefact most likely to be pasted somewhere public, so the
    // redaction is enforced rather than trusted.
    const trail = new AuditTrail();
    expect(() =>
      trail.record({
        type: "action.refused",
        at: new Date().toISOString(),
        findingId: "f1",
        reason: `token was ${REAL_LOOKING_SECRET}`,
      }),
    ).toThrow(AuditLeakError);
  });

  it.each([
    ["ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"],
    ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz"],
    ["AIzaSyDb2Cr6pX21OYVaWlWfS5xOreMfN9sS7Y"],
  ])("detects %s as credential-shaped", (value) => {
    expect(() => assertNoSecrets(`{"x":"${value}"}`)).toThrow(AuditLeakError);
  });

  it("allows a masked value through", () => {
    expect(() => assertNoSecrets('{"maskedSecret":"ghp_********6789"}')).not.toThrow();
  });

  it("keeps events in the order they happened", () => {
    const trail = new AuditTrail();
    const at = "2026-08-27T10:00:00Z";
    trail.record({ type: "run.started", at, runId: "r1", repository: "x", dryRun: false });
    trail.recordFinding(finding("f1"), at);
    trail.recordVerification(record("f1", "LIVE"), at);
    trail.record({ type: "run.completed", at, runId: "r1", durationMs: 100 });

    expect(trail.events().map((e) => e.type)).toEqual([
      "run.started",
      "finding.discovered",
      "verification.completed",
      "run.completed",
    ]);
  });

  it("emits one JSON object per line", () => {
    const trail = new AuditTrail();
    const at = "2026-08-27T10:00:00Z";
    trail.recordFinding(finding("f1"), at);
    trail.recordFinding(finding("f2"), at);

    const lines = trail.toJSONL().trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
