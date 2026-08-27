/**
 * The policy that decides what happens to each finding.
 *
 * Kept as data rather than branches inside the planner so it can be read by someone
 * who does not read TypeScript, and changed without touching the loop. The point the
 * project is making is that approval is policy-driven rather than hardcoded: nothing
 * here can be edited to let the agent revoke something on its own, because
 * `requiresApproval` is fixed true for every rule that ends in a destructive action.
 */
import type { SecretStatus } from "../types.js";

export type RemediationAction =
  /** Kill the credential, then issue a replacement. */
  | "revoke_and_rotate"
  /** Credential is already dead; the value should still come out of git history. */
  | "strip_from_history"
  /** We could not establish enough to act. A person decides. */
  | "manual_review";

export interface PolicyRule {
  id: string;
  /** Which verification outcome this rule applies to. */
  when: SecretStatus;
  action: RemediationAction;
  /** Stated in the plan so every item carries its justification. */
  rationale: string;
  /**
   * Whether a human must approve before this action runs.
   *
   * True for every action that touches a provider. There is no rule, and no
   * configuration, that produces an unapproved destructive action.
   */
  requiresApproval: boolean;
}

export const DEFAULT_POLICY: readonly PolicyRule[] = [
  {
    id: "live-credential-requires-approval",
    when: "LIVE",
    action: "revoke_and_rotate",
    rationale:
      "The credential still authenticates, so it is usable by anyone who has the repository. " +
      "Revoking is irreversible and may break whatever is currently using it, so a human decides.",
    requiresApproval: true,
  },
  {
    id: "dead-credential-strip-from-history",
    when: "DEAD",
    action: "strip_from_history",
    rationale:
      "The provider already rejects this credential, so there is nothing to revoke. " +
      "It should still be removed from git history so it stops being reported and stops " +
      "misleading whoever reads the repository next.",
    requiresApproval: false,
  },
  {
    id: "unverified-credential-manual-review",
    when: "UNKNOWN",
    action: "manual_review",
    rationale:
      "Verification did not produce a usable answer. Guessing in either direction is worse " +
      "than asking: a wrong DEAD leaves a working credential in place, and a wrong LIVE " +
      "spends someone's time revoking nothing.",
    requiresApproval: false,
  },
  {
    id: "unverified-status-manual-review",
    when: "UNVERIFIED",
    action: "manual_review",
    rationale: "This finding was never verified, so there is no basis for an automatic decision.",
    requiresApproval: false,
  },
];

export function ruleFor(
  status: SecretStatus,
  policy: readonly PolicyRule[] = DEFAULT_POLICY,
): PolicyRule {
  const rule = policy.find((r) => r.when === status);
  if (!rule) {
    // Falling through to a permissive default would be exactly the wrong failure
    // mode, so an unmapped status becomes a manual review instead.
    return {
      id: "fallback-manual-review",
      when: status,
      action: "manual_review",
      rationale: `No policy rule covers status "${status}", so a human decides.`,
      requiresApproval: false,
    };
  }
  return rule;
}
