/**
 * The audit trail.
 *
 * Append-only, ordered, and written as JSON Lines so a run can be read back or diffed
 * without any tooling. It answers the question someone will eventually ask: why was
 * this credential destroyed, who said so, and what did they know at the time.
 *
 * Nothing here may contain a raw credential. The trail is the artefact most likely to
 * be copied into a ticket, pasted into chat, or committed by accident, so the
 * redaction is enforced rather than left to whoever writes the next event type.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plan, PlanItem } from "../agent/plan.js";
import type { BlastRadius } from "../templates/blast-radius.js";
import type { ApprovalDecision } from "../policy/approval.js";
import type { RevokeRecord } from "../tools/revoke.js";
import type { VerificationRecord } from "../tools/verify.js";
import type { Finding, SecretStatus } from "../types.js";
import { redact } from "../types.js";

export type AuditEvent =
  | { type: "run.started"; at: string; runId: string; repository: string; dryRun: boolean }
  | { type: "scan.completed"; at: string; scanner: string; findingCount: number }
  | {
      type: "finding.discovered";
      at: string;
      findingId: string;
      provider: string;
      ruleId: string;
      maskedSecret: string;
      location: string;
      commit: string;
      author: string;
      commitMessage: string;
    }
  | {
      type: "verification.completed";
      at: string;
      findingId: string;
      templateId: string | null;
      sandboxKind: string | null;
      status: SecretStatus;
      httpStatus?: number | undefined;
      principal?: string | undefined;
      capabilities: string[];
      blastRadius: BlastRadius;
      elapsedMs: number;
      reason?: string | undefined;
    }
  | { type: "plan.built"; at: string; items: PlanItem[]; summary: Plan["summary"] }
  | {
      type: "approval.requested";
      at: string;
      findingId: string;
      action: string;
      blastRadius: string;
    }
  | {
      type: "approval.decided";
      at: string;
      findingId: string;
      decision: ApprovalDecision;
      decidedBy: string;
      reason?: string | undefined;
    }
  | {
      type: "revoke.completed";
      at: string;
      findingId: string;
      attempted: boolean;
      httpStatus?: number | undefined;
      statusBefore: SecretStatus;
      statusAfter: SecretStatus;
      confirmed: boolean;
      approvedBy: string;
      dryRun: boolean;
      note?: string | undefined;
    }
  /** A human, or the gate, declined. Somebody said no. */
  | { type: "action.refused"; at: string; findingId: string; reason: string }
  /**
   * The action was permitted but did not complete. Distinct from a refusal, because
   * reading a network fault as "refused" months later suggests a decision nobody made.
   */
  | { type: "action.failed"; at: string; findingId: string; reason: string }
  | { type: "run.completed"; at: string; runId: string; durationMs: number };

/** Shapes that look like credentials. Used to prove no event carries one. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[ousr]_[A-Za-z0-9]{20,}/,
  /AIza[A-Za-z0-9_-]{20,}/,
  /dtn_[a-f0-9]{32,}/,
];

export class AuditLeakError extends Error {}

/**
 * Throw if a serialised event contains something credential-shaped.
 *
 * A trailing safety net, not the primary mechanism: callers are expected to pass
 * masked values. It exists because the cost of one unmasked field reaching a log file
 * is high and the cost of this check is nothing.
 */
export function assertNoSecrets(serialised: string): void {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(serialised);
    if (match) {
      throw new AuditLeakError(
        `Refusing to record an audit event containing a credential-shaped value ` +
          `(${match[0].slice(0, 8)}...). Mask it before recording.`,
      );
    }
  }
}

export class AuditTrail {
  readonly #events: AuditEvent[] = [];
  /** How many events have already been written, so a second save appends only new ones. */
  #savedUpTo = 0;
  /** Serialises saves. Two concurrent calls would otherwise read the same offset. */
  #writing: Promise<void> = Promise.resolve();

  record(event: AuditEvent): void {
    const serialised = JSON.stringify(event);
    assertNoSecrets(serialised);
    this.#events.push(event);
  }

  /**
   * A copy. The trail is append-only and the validation happens on the way in, so
   * handing out the live array would let a caller edit a recorded event afterwards,
   * past the check that is supposed to keep credentials out of it.
   */
  events(): readonly AuditEvent[] {
    return this.#events.map((e) => ({ ...e }));
  }

  /** One JSON object per line, in the order things happened. */
  toJSONL(): string {
    return this.#events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  /**
   * Append to the trail file.
   *
   * Only events not already written. Saving appends, so writing the whole trail each
   * time duplicated every earlier event, and a run saved twice would read as though
   * everything had happened twice.
   */
  async save(path: string): Promise<void> {
    const pending = this.#events.slice(this.#savedUpTo);
    if (pending.length === 0) return;
    await mkdir(dirname(path), { recursive: true });
    const lines = pending.map((e) => JSON.stringify(e)).join("\n");
    await appendFile(path, lines + "\n", "utf8");
    this.#savedUpTo = this.#events.length;
  }

  // Convenience recorders. They exist so the redaction happens in one place rather
  // than at every call site.

  recordFinding(finding: Finding, at = new Date().toISOString()): void {
    this.record({
      type: "finding.discovered",
      at,
      findingId: finding.id,
      provider: finding.provider,
      ruleId: finding.ruleId,
      maskedSecret: redact(finding.secret),
      location: `${finding.file}:${finding.startLine}`,
      commit: finding.commit,
      author: finding.author,
      commitMessage: finding.commitMessage,
    });
  }

  recordVerification(record: VerificationRecord, at = new Date().toISOString()): void {
    this.record({
      type: "verification.completed",
      at,
      findingId: record.findingId,
      templateId: record.templateId,
      sandboxKind: record.sandboxKind,
      status: record.status,
      httpStatus: record.httpStatus,
      principal: record.principal,
      capabilities: record.capabilities,
      blastRadius: record.blastRadius,
      elapsedMs: record.elapsedMs,
      reason: record.reason,
    });
  }

  recordRevoke(record: RevokeRecord, at = new Date().toISOString()): void {
    this.record({
      type: "revoke.completed",
      at,
      findingId: record.findingId,
      attempted: record.attempted,
      httpStatus: record.httpStatus,
      statusBefore: record.statusBefore,
      statusAfter: record.statusAfter,
      confirmed: record.confirmed,
      approvedBy: record.approvedBy,
      dryRun: record.dryRun,
      note: record.note,
    });
  }
}
