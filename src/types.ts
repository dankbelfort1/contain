/** Shared types for the ContAIn loop. */

/** Result of running a verification template against a credential. */
export type SecretStatus =
  /** The credential authenticated successfully. */
  | "LIVE"
  /** The provider rejected the credential. */
  | "DEAD"
  /** The provider could not be reached, or answered ambiguously. */
  | "UNKNOWN"
  /** No verification has been attempted yet. */
  | "UNVERIFIED";

/** One secret located by the scanner. */
export interface Finding {
  /**
   * Stable identifier derived from the finding's location and rule, so the same
   * repository state always produces the same ids. Deliberately excludes the
   * secret value so ids can be logged freely.
   */
  id: string;
  /** Provider this credential belongs to, e.g. "github". "unknown" if unrecognised. */
  provider: string;
  /** The gitleaks rule that matched, e.g. "github-pat". */
  ruleId: string;
  /** Raw credential value. Never log this directly - use redact(). */
  secret: string;
  /** Path within the repository. */
  file: string;
  startLine: number;
  /** Commit the secret was introduced in. */
  commit: string;
  author: string;
  email: string;
  /** Commit timestamp, ISO 8601. */
  date: string;
  /** First line of the commit message the secret arrived in. */
  commitMessage: string;
}

/**
 * Mask a credential for logs and UI. Keeps the provider prefix visible, because
 * knowing it is a GitHub token is useful and not sensitive, and shows the last
 * four characters so a human can correlate it with a provider's token list.
 */
export function redact(secret: string): string {
  if (secret.length <= 12) return "*".repeat(secret.length);
  const prefixMatch = /^(ghp_|github_pat_|gho_|ghu_|ghr_|AIza|dtn_|sk-)/.exec(secret);
  const prefix = prefixMatch?.[1] ?? "";
  const tail = secret.slice(-4);
  return `${prefix}${"*".repeat(Math.max(4, secret.length - prefix.length - 4))}${tail}`;
}
