/**
 * Verification: does this credential still work, and what can it reach?
 *
 * The agent chooses a template by provider and supplies the credential. It does not
 * write the probe. Everything here is read-only, which is what lets the agent run it
 * without asking anyone's permission - the whole point of the split between
 * investigation and action.
 */
import { z } from "zod";
import type { BlastRadius } from "../templates/blast-radius.js";
import { describeGitHubBlastRadius } from "../templates/blast-radius.js";
import { templateForProvider } from "../templates/registry.js";
import type { VerificationOutcome } from "../templates/types.js";
import type { SandboxExecutor, SandboxKind } from "../sandbox/types.js";
import type { Finding, SecretStatus } from "../types.js";

/** What a template is allowed to return. Anything else is treated as a failure. */
const outcomeSchema = z.object({
  status: z.enum(["LIVE", "DEAD", "UNKNOWN"]),
  httpStatus: z.number().int().optional(),
  principal: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  facts: z.record(z.string(), z.unknown()).default({}),
  /** Why the template could not decide, when it could not. */
  reason: z.string().optional(),
});

export interface VerificationRecord {
  findingId: string;
  provider: string;
  /** Null when no template covers this provider. */
  templateId: string | null;
  status: SecretStatus;
  httpStatus?: number;
  principal?: string;
  capabilities: string[];
  blastRadius: BlastRadius;
  sandboxKind: SandboxKind | null;
  elapsedMs: number;
  /** Why the result is UNKNOWN, when it is. */
  reason?: string;
}

/**
 * Verify one finding inside the sandbox.
 *
 * Never throws for an unverifiable credential. A thrown error would stop the run, and
 * one unreachable provider should not prevent the other findings being triaged, so
 * failures come back as UNKNOWN with the reason recorded.
 */
export async function verifyFinding(
  finding: Finding,
  sandbox: SandboxExecutor,
): Promise<VerificationRecord> {
  const template = templateForProvider(finding.provider);

  if (!template) {
    return unverifiable(
      finding,
      `No verification template for provider "${finding.provider}". Needs a human.`,
    );
  }

  const result = await sandbox.run({
    templateSource: template.source,
    params: { token: finding.secret },
    // The template declares the only hosts it may reach. Nothing else is permitted,
    // so a template cannot be repurposed to send a credential somewhere else.
    allowHosts: template.allowHosts,
    timeoutMs: template.timeoutMs,
  });

  if (!result.ok) {
    return {
      ...unverifiable(finding, `Sandbox run failed: ${result.error ?? "unknown"}`),
      templateId: template.id,
      sandboxKind: result.sandboxKind,
      elapsedMs: result.elapsedMs,
    };
  }

  const parsed = outcomeSchema.safeParse(result.value);
  if (!parsed.success) {
    return {
      ...unverifiable(finding, `Template returned an unexpected shape: ${parsed.error.message}`),
      templateId: template.id,
      sandboxKind: result.sandboxKind,
      elapsedMs: result.elapsedMs,
    };
  }

  const outcome: VerificationOutcome = parsed.data;

  return {
    findingId: finding.id,
    provider: finding.provider,
    templateId: template.id,
    status: outcome.status,
    ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
    ...(outcome.principal !== undefined ? { principal: outcome.principal } : {}),
    capabilities: outcome.capabilities,
    blastRadius: describeBlastRadius(finding.provider, outcome),
    sandboxKind: result.sandboxKind,
    elapsedMs: result.elapsedMs,
    ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
  };
}

/** Verify a batch, one at a time so the audit trail stays readable and ordered. */
export async function verifyAll(
  findings: readonly Finding[],
  sandbox: SandboxExecutor,
): Promise<VerificationRecord[]> {
  const records: VerificationRecord[] = [];
  for (const finding of findings) {
    try {
      records.push(await verifyFinding(finding, sandbox));
    } catch (error) {
      // A sandbox that throws rather than returning a failed result would otherwise
      // abandon every finding after this one. Triaging the rest matters more than
      // failing fast on one.
      records.push(unverifiable(finding, `Verification threw: ${String(error)}`));
    }
  }
  return records;
}

function describeBlastRadius(provider: string, outcome: VerificationOutcome): BlastRadius {
  if (provider === "github") return describeGitHubBlastRadius(outcome);
  return {
    headline: "No blast radius assessment available for this provider.",
    capabilities: [],
    reach: [],
    worstSeverity: "low",
  };
}

function unverifiable(finding: Finding, reason: string): VerificationRecord {
  return {
    findingId: finding.id,
    provider: finding.provider,
    templateId: null,
    status: "UNKNOWN",
    capabilities: [],
    blastRadius: {
      headline: "Could not be established. A human needs to look at this one.",
      capabilities: [],
      reach: [],
      worstSeverity: "low",
    },
    sandboxKind: null,
    elapsedMs: 0,
    reason,
  };
}
