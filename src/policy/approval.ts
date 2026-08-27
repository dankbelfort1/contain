/**
 * The trust boundary.
 *
 * An approval is not a boolean and not a UI state. It is a single-use grant, bound to
 * one specific finding and one specific credential value, that the revoke tool must
 * present before it will act. Nothing else unlocks a destructive action.
 *
 * Binding matters as much as the grant. GitHub's revoke endpoint is unauthenticated
 * and will revoke any token anyone submits, so "a human approved something" is not
 * enough - the approval has to prove which credential it approved. Without that, a
 * confused or manipulated agent could present a valid approval alongside a different
 * token and destroy an unrelated third party's credential.
 */
import { createHash, randomUUID } from "node:crypto";

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalGrant {
  /** Opaque single-use token the revoke tool must present. */
  token: string;
  findingId: string;
  /**
   * SHA-256 of the credential this approval covers. We store the digest rather than
   * the credential so the approval log can be kept and read without holding secrets.
   */
  secretFingerprint: string;
  decision: ApprovalDecision;
  grantedBy: string;
  grantedAt: string;
  reason?: string | undefined;
}

/** Recorded once a grant has been spent, so a retry cannot fire a second time. */
export interface ConsumedGrant<T = unknown> {
  grant: ApprovalGrant;
  consumedAt: string;
  outcome: T;
}

export class ApprovalError extends Error {}

export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Holds approvals for one run.
 *
 * Deliberately in-memory and scoped to a single run. An approval should not outlive
 * the investigation that justified it: the blast radius a human saw is what they
 * agreed to, and that assessment goes stale.
 */
export class ApprovalRegistry {
  readonly #grants = new Map<string, ApprovalGrant>();
  readonly #consumed = new Map<string, ConsumedGrant>();
  /** Tokens currently being spent, so two callers cannot both pass the check. */
  readonly #inFlight = new Set<string>();

  /** Record a human decision. Only an "allow" produces a usable token. */
  grant(params: {
    findingId: string;
    secret: string;
    decision: ApprovalDecision;
    grantedBy: string;
    reason?: string | undefined;
  }): ApprovalGrant {
    const grant: ApprovalGrant = {
      token: randomUUID(),
      findingId: params.findingId,
      secretFingerprint: fingerprint(params.secret),
      decision: params.decision,
      grantedBy: params.grantedBy,
      grantedAt: new Date().toISOString(),
      reason: params.reason,
    };
    this.#grants.set(grant.token, grant);
    return grant;
  }

  /**
   * Check a token without spending it. Throws with the specific reason it is not
   * usable, so the audit trail records why an action was refused.
   */
  validate(token: string | undefined, findingId: string, secret: string): ApprovalGrant {
    if (!token) {
      throw new ApprovalError("Human approval required. This action may affect production.");
    }
    const grant = this.#grants.get(token);
    if (!grant) {
      throw new ApprovalError("Approval token is not recognised.");
    }
    if (grant.decision !== "allow") {
      throw new ApprovalError(`Approval was denied${grant.reason ? `: ${grant.reason}` : "."}`);
    }
    if (grant.findingId !== findingId) {
      throw new ApprovalError(
        `Approval covers finding ${grant.findingId}, not ${findingId}.`,
      );
    }
    if (grant.secretFingerprint !== fingerprint(secret)) {
      throw new ApprovalError(
        "Approval does not cover this credential. The value differs from the one that was approved.",
      );
    }
    return grant;
  }

  /** Whether this grant has already been spent. */
  consumedResult<T>(token: string): ConsumedGrant<T> | undefined {
    return this.#consumed.get(token) as ConsumedGrant<T> | undefined;
  }

  /**
   * Claim a grant before doing anything irreversible with it.
   *
   * Checking "already consumed" and then acting is two steps, and JavaScript will
   * happily interleave an await between them. Two concurrent revocations for the same
   * approval both passed the check and both fired. Claiming is a single synchronous
   * step, so only one caller can win.
   *
   * @returns true if this caller now owns the grant.
   */
  claim(token: string): boolean {
    if (this.#consumed.has(token) || this.#inFlight.has(token)) return false;
    this.#inFlight.add(token);
    return true;
  }

  /** Release a claim that did not complete, so the action can be retried. */
  release(token: string): void {
    this.#inFlight.delete(token);
  }

  /** Mark a grant spent and record what it produced. */
  markConsumed<T>(token: string, outcome: T): void {
    const grant = this.#grants.get(token);
    if (!grant) throw new ApprovalError("Cannot consume an unknown approval token.");
    this.#consumed.set(token, {
      grant,
      consumedAt: new Date().toISOString(),
      outcome,
    });
    this.#inFlight.delete(token);
  }

  /** Every decision made this run, for the audit trail. */
  all(): readonly ApprovalGrant[] {
    return [...this.#grants.values()];
  }
}
