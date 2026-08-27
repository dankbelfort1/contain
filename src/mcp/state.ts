/**
 * State for one remediation run.
 *
 * The MCP tools are individually stateless calls, but the loop is not: a plan refers
 * to verifications, an approval refers to a finding, and a revoke refers to both. This
 * holds that between calls.
 *
 * Credentials live here and nowhere else. They are never returned from a tool, never
 * written to the audit trail, and never sent to the model. The model works with
 * finding ids and masked values; the real value is looked up here at the moment it is
 * needed. That is what stops a leaked credential being leaked a second time by the
 * thing sent to clean it up.
 */
import { randomBytes } from "node:crypto";
import type { Plan } from "../agent/plan.js";
import { AuditTrail } from "../harness/audit.js";
import { ApprovalRegistry } from "../policy/approval.js";
import type { VerificationRecord } from "../tools/verify.js";
import type { Finding } from "../types.js";
import { redact } from "../types.js";

/** A finding with its credential removed. This is what tools return. */
export interface SafeFinding {
  findingId: string;
  provider: string;
  ruleId: string;
  maskedSecret: string;
  file: string;
  startLine: number;
  commit: string;
  author: string;
  date: string;
  commitMessage: string;
}

export function toSafeFinding(finding: Finding): SafeFinding {
  return {
    findingId: finding.id,
    provider: finding.provider,
    ruleId: finding.ruleId,
    maskedSecret: redact(finding.secret),
    file: finding.file,
    startLine: finding.startLine,
    commit: finding.commit,
    author: finding.author,
    date: finding.date,
    commitMessage: finding.commitMessage,
  };
}

export class RunState {
  // The timestamp alone collides for runs started in the same millisecond, and the
  // run id names the audit file, so a collision means one run appending to another's
  // trail.
  readonly runId = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  readonly startedAt = Date.now();
  readonly audit = new AuditTrail();
  readonly approvals = new ApprovalRegistry();

  #repository: string | undefined;
  readonly #findings = new Map<string, Finding>();
  readonly #verifications = new Map<string, VerificationRecord>();
  #plan: Plan | undefined;

  get repository(): string | undefined {
    return this.#repository;
  }

  setFindings(repository: string, findings: readonly Finding[]): void {
    this.#repository = repository;
    this.#findings.clear();
    this.#verifications.clear();
    this.#plan = undefined;
    for (const finding of findings) this.#findings.set(finding.id, finding);
  }

  findings(): readonly Finding[] {
    return [...this.#findings.values()];
  }

  /** The full finding, credential included. Internal callers only. */
  finding(findingId: string): Finding | undefined {
    return this.#findings.get(findingId);
  }

  setVerification(record: VerificationRecord): void {
    this.#verifications.set(record.findingId, record);
  }

  verification(findingId: string): VerificationRecord | undefined {
    return this.#verifications.get(findingId);
  }

  verifications(): readonly VerificationRecord[] {
    return [...this.#verifications.values()];
  }

  setPlan(plan: Plan): void {
    this.#plan = plan;
  }

  plan(): Plan | undefined {
    return this.#plan;
  }
}
