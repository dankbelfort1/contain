/**
 * The only destructive action in the system.
 *
 * Three things are true of GitHub's revoke endpoint, all confirmed against the live
 * API in docs/phase-0.md, and each one shapes this code:
 *
 *   1. It must be called with no Authorization header. An authenticated request is
 *      rejected. This is easy to reintroduce by sharing an HTTP client with the
 *      verification path, so it is asserted by test.
 *   2. It returns 202 unconditionally, including for a credential that never existed.
 *      The response is therefore not evidence. We re-run the read-only verification
 *      afterwards and record what we observed, not what we were told.
 *   3. It is unauthenticated and global. Anyone can revoke anyone's token, and GitHub
 *      cannot undo it. That is why the approval must be bound to a specific credential
 *      rather than simply existing.
 */
import { ApprovalError, type ApprovalRegistry } from "../policy/approval.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import { verifyFinding } from "./verify.js";
import type { Finding, SecretStatus } from "../types.js";

export const GITHUB_REVOKE_URL = "https://api.github.com/credentials/revoke";

/** Injectable so tests can assert what would be sent without sending it. */
export type RevokePoster = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

export interface RevokeRecord {
  findingId: string;
  provider: string;
  /** False when the call was withheld: a dry run, or an already-spent approval. */
  attempted: boolean;
  httpStatus?: number | undefined;
  statusBefore: SecretStatus;
  /** Observed by re-running verification. Not inferred from the HTTP response. */
  statusAfter: SecretStatus;
  /** True only when we watched the credential stop working. */
  confirmed: boolean;
  approvalToken: string;
  approvedBy: string;
  at: string;
  dryRun: boolean;
  note?: string | undefined;
}

export interface RevokeParams {
  finding: Finding;
  statusBefore: SecretStatus;
  approvalToken: string | undefined;
  registry: ApprovalRegistry;
  /** Used to re-verify afterwards, proving the credential is actually dead. */
  sandbox: SandboxExecutor;
  dryRun?: boolean;
  post?: RevokePoster;
}

const defaultPost: RevokePoster = async (url, body, headers) => {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status };
};

/**
 * Revoke a credential. Throws ApprovalError if no valid approval covers it, before any
 * network call is made.
 */
export async function revokeCredential(params: RevokeParams): Promise<RevokeRecord> {
  const { finding, registry, sandbox } = params;
  const dryRun = params.dryRun ?? false;
  const post = params.post ?? defaultPost;

  // Throws unless a human allowed this exact credential. Nothing below runs otherwise.
  const grant = registry.validate(params.approvalToken, finding.id, finding.secret);

  // An approval is spent once. A retry returns what the first call produced rather
  // than issuing a second irreversible request.
  const already = registry.consumedResult<RevokeRecord>(grant.token);
  if (already) {
    return { ...already.outcome, attempted: false, note: "Already revoked; approval was spent." };
  }

  if (finding.provider !== "github") {
    throw new ApprovalError(`No revoke tool for provider "${finding.provider}".`);
  }

  const base: Omit<RevokeRecord, "statusAfter" | "confirmed" | "attempted"> = {
    findingId: finding.id,
    provider: finding.provider,
    statusBefore: params.statusBefore,
    approvalToken: grant.token,
    approvedBy: grant.grantedBy,
    at: new Date().toISOString(),
    dryRun,
  };

  if (dryRun) {
    // A dry run must never fire. This is the path replay uses, and replaying a run
    // must not destroy a credential a second time.
    return {
      ...base,
      attempted: false,
      statusAfter: params.statusBefore,
      confirmed: false,
      note: "Dry run. No request was sent.",
    };
  }

  const { status } = await post(
    GITHUB_REVOKE_URL,
    { credentials: [finding.secret] },
    {
      // No Authorization header. GitHub rejects authenticated calls to this endpoint.
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "contain-revoker",
    },
  );

  // The 202 tells us nothing, so go and look.
  const after = await verifyFinding(finding, sandbox);

  const record: RevokeRecord = {
    ...base,
    attempted: true,
    httpStatus: status,
    statusAfter: after.status,
    confirmed: after.status === "DEAD",
    ...(after.status !== "DEAD"
      ? {
          note:
            "GitHub accepted the request but the credential still authenticates. " +
            "Do not treat this as revoked.",
        }
      : {}),
  };

  registry.markConsumed(grant.token, record);
  return record;
}
