/**
 * Builds the remediation plan.
 *
 * Every item states what to do and why. The "why" is not decoration: it is what the
 * person at the approval gate reads before deciding, and it is what makes the audit
 * trail answerable later when someone asks why a credential was destroyed.
 */
import type { Severity } from "../templates/blast-radius.js";
import type { VerificationRecord } from "../tools/verify.js";
import type { PolicyRule, RemediationAction } from "../policy/rules.js";
import { DEFAULT_POLICY, ruleFor } from "../policy/rules.js";
import type { Finding, SecretStatus } from "../types.js";
import { redact } from "../types.js";

export interface PlanItem {
  findingId: string;
  /** Masked value, safe to display and log. */
  maskedSecret: string;
  location: string;
  provider: string;
  status: SecretStatus;
  action: RemediationAction;
  /** Why this action, in plain words. */
  reason: string;
  /** What the credential can reach, when it is live. */
  blastRadius: string;
  requiresApproval: boolean;
  severity: Severity;
  /** The policy rule that produced this item, for the audit trail. */
  ruleId: string;
}

export interface Plan {
  items: PlanItem[];
  summary: {
    total: number;
    live: number;
    dead: number;
    unknown: number;
    /** How many items cannot proceed without a human. */
    awaitingApproval: number;
    /** How many items a person has to pick up by hand. */
    needsManualReview: number;
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Actions that touch a provider irreversibly. Always gated, whatever a policy says. */
const DESTRUCTIVE_ACTIONS = new Set<RemediationAction>(["revoke_and_rotate"]);

/**
 * Turn findings and their verification results into an ordered plan.
 *
 * Ordered worst first, so the item a human most needs to think about is the one they
 * see. Live credentials always outrank dead ones regardless of severity, because a
 * dead credential is paperwork and a live one is an open door.
 */
export function buildPlan(
  findings: readonly Finding[],
  records: readonly VerificationRecord[],
  policy: readonly PolicyRule[] = DEFAULT_POLICY,
): Plan {
  const byId = new Map(records.map((r) => [r.findingId, r]));

  const items = findings.map((finding): PlanItem => {
    const record = byId.get(finding.id);
    const status: SecretStatus = record?.status ?? "UNVERIFIED";
    const rule = ruleFor(status, policy);

    return {
      findingId: finding.id,
      maskedSecret: redact(finding.secret),
      location: `${finding.file}:${finding.startLine}`,
      provider: finding.provider,
      status,
      action: rule.action,
      reason: buildReason(rule, finding, record),
      blastRadius: record?.blastRadius.headline ?? "Not assessed.",
      // Not read straight from the rule. A caller-supplied policy could otherwise
      // set requiresApproval false on a destructive action and quietly remove the
      // gate, which is the one thing no configuration is allowed to do.
      requiresApproval: rule.requiresApproval || DESTRUCTIVE_ACTIONS.has(rule.action),
      severity: record?.blastRadius.worstSeverity ?? "low",
      ruleId: rule.id,
    };
  });

  items.sort(worstFirst);

  return {
    items,
    summary: {
      total: items.length,
      live: items.filter((i) => i.status === "LIVE").length,
      dead: items.filter((i) => i.status === "DEAD").length,
      unknown: items.filter((i) => i.status === "UNKNOWN" || i.status === "UNVERIFIED").length,
      awaitingApproval: items.filter((i) => i.requiresApproval).length,
      needsManualReview: items.filter((i) => i.action === "manual_review").length,
    },
  };
}

function worstFirst(a: PlanItem, b: PlanItem): number {
  // A live credential always comes before a dead one. Severity only breaks ties
  // within the same status.
  //
  // UNVERIFIED ranks with UNKNOWN rather than with DEAD. Something never checked is
  // not evidence of safety, and sorting it next to credentials known to be harmless
  // buries it where nobody looks.
  const liveRank = (i: PlanItem) =>
    i.status === "LIVE" ? 0 : i.status === "UNKNOWN" || i.status === "UNVERIFIED" ? 1 : 2;
  if (liveRank(a) !== liveRank(b)) return liveRank(a) - liveRank(b);
  if (a.severity !== b.severity) return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  return a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0;
}

function buildReason(
  rule: PolicyRule,
  finding: Finding,
  record: VerificationRecord | undefined,
): string {
  const parts = [rule.rationale];

  if (record?.reason) {
    parts.push(record.reason);
  }

  // Where a leak came from is part of the reason: a credential committed and later
  // deleted is still live in history, and whoever fixes it needs to know that
  // deleting the file again will not help.
  parts.push(
    `Introduced in ${finding.commit.slice(0, 8)} by ${finding.author}, ` +
      `in "${finding.commitMessage}".`,
  );

  return parts.join(" ");
}
