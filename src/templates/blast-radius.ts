/**
 * Turns a provider's capability strings into something a human can act on.
 *
 * "repo, delete_repo, admin:org" is precise but means nothing at a glance. The person
 * deciding whether to revoke needs to know what breaks and what is exposed, in a
 * sentence, before they click. That judgement is the whole point of the approval gate,
 * so it has to be readable under pressure.
 */
import type { VerificationOutcome } from "./types.js";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Capability {
  scope: string;
  severity: Severity;
  /** What this permits, in plain words. */
  plain: string;
}

export interface BlastRadius {
  /** One sentence, worst thing first. */
  headline: string;
  /** Every capability, most severe first. */
  capabilities: Capability[];
  /** What the credential actually reaches, from the provider's own numbers. */
  reach: string[];
  worstSeverity: Severity;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * GitHub OAuth scopes in plain English.
 *
 * Severity is about blast radius if the credential is already in someone else's hands,
 * not about how routine the scope is day to day.
 */
const GITHUB_SCOPES: Record<string, { severity: Severity; plain: string }> = {
  "admin:enterprise": { severity: "critical", plain: "administer the enterprise account" },
  "admin:org": { severity: "critical", plain: "administer organisations, including who belongs to them" },
  delete_repo: { severity: "critical", plain: "permanently delete repositories" },
  repo: { severity: "critical", plain: "read and write every repository this account can reach, private ones included" },
  "delete:packages": { severity: "high", plain: "delete published packages" },
  "admin:org_hook": { severity: "high", plain: "add or change organisation webhooks" },
  "admin:repo_hook": { severity: "high", plain: "add or change repository webhooks" },
  "admin:public_key": { severity: "high", plain: "add SSH keys to the account, which grants lasting access" },
  "admin:ssh_signing_key": { severity: "high", plain: "add SSH signing keys, which lets commits be forged as this user" },
  "admin:gpg_key": { severity: "high", plain: "add GPG keys, which lets commits be signed as this user" },
  workflow: { severity: "high", plain: "change GitHub Actions workflows, which run with their own secrets" },
  "write:packages": { severity: "high", plain: "publish packages that others will install" },
  user: { severity: "high", plain: "read and change the account profile, including its email addresses" },
  "write:network_configurations": { severity: "high", plain: "change network configuration" },
  codespace: { severity: "medium", plain: "create and control codespaces" },
  project: { severity: "medium", plain: "read and change projects" },
  "write:discussion": { severity: "medium", plain: "post and edit discussions" },
  gist: { severity: "medium", plain: "create and edit gists" },
  notifications: { severity: "medium", plain: "read notifications" },
  audit_log: { severity: "medium", plain: "read the audit log" },
  copilot: { severity: "low", plain: "use Copilot on this account" },
  "read:org": { severity: "low", plain: "read organisation membership" },
  "read:user": { severity: "low", plain: "read the account profile" },
  "user:email": { severity: "low", plain: "read the account's email addresses" },
};

function classify(scope: string): Capability {
  const known = GITHUB_SCOPES[scope];
  if (known) return { scope, severity: known.severity, plain: known.plain };
  // An unrecognised scope is treated as high rather than ignored. Under-reporting a
  // capability is worse than over-reporting one.
  return { scope, severity: "high", plain: `use the ${scope} scope (not in our catalogue)` };
}

/** Describe what a live GitHub credential can do. */
export function describeGitHubBlastRadius(outcome: VerificationOutcome): BlastRadius {
  if (outcome.status !== "LIVE") {
    return {
      headline:
        outcome.status === "DEAD"
          ? "Not live. The provider rejected this credential, so it grants nothing."
          : "Could not be established. The provider did not give a usable answer.",
      capabilities: [],
      reach: [],
      worstSeverity: "low",
    };
  }

  const capabilities = outcome.capabilities
    .map(classify)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    headline: buildHeadline(outcome, capabilities),
    capabilities,
    reach: describeReach(outcome),
    worstSeverity: capabilities[0]?.severity ?? "low",
  };
}

function buildHeadline(outcome: VerificationOutcome, capabilities: Capability[]): string {
  const who = outcome.principal ? `the account "${outcome.principal}"` : "an account";

  if (capabilities.length === 0) {
    const kind = outcome.facts["tokenKind"];
    // Fine-grained tokens authenticate but do not publish their scopes this way, so
    // silence here means "we cannot see", not "it can do nothing".
    return kind === "fine-grained"
      ? `Live on ${who}. This is a fine-grained token, so GitHub does not report its permissions here - they need checking by hand.`
      : `Live on ${who}, but GitHub reported no scopes for it.`;
  }

  const worst = capabilities.filter((c) => c.severity === capabilities[0]?.severity);
  const listed = worst.slice(0, 3).map((c) => c.plain);
  const phrase =
    listed.length === 1
      ? listed[0]
      : `${listed.slice(0, -1).join(", ")}, and ${listed[listed.length - 1]}`;

  const remaining = capabilities.length - worst.slice(0, 3).length;
  const tail = remaining > 0 ? ` Plus ${remaining} further permission${remaining === 1 ? "" : "s"}.` : "";

  return `Live on ${who}. Anyone holding this key can ${phrase}.${tail}`;
}

function describeReach(outcome: VerificationOutcome): string[] {
  const f = outcome.facts;
  const reach: string[] = [];
  const priv = num(f["totalPrivateRepos"]);
  const pub = num(f["publicRepos"]);

  if (priv !== undefined && priv > 0) {
    reach.push(`${priv} private repositor${priv === 1 ? "y" : "ies"} on this account`);
  }
  if (pub !== undefined) {
    reach.push(`${pub} public repositor${pub === 1 ? "y" : "ies"}`);
  }
  const collaborators = num(f["collaborators"]);
  if (collaborators !== undefined && collaborators > 0) {
    reach.push(`${collaborators} collaborator${collaborators === 1 ? "" : "s"} who share those repositories`);
  }
  if (f["siteAdmin"] === true) {
    reach.push("a site administrator account");
  }
  if (f["twoFactorEnabled"] === false) {
    // Not a capability of the token, but it tells the responder the account itself is
    // easier to take over once a working credential is in hand.
    reach.push("an account without two-factor authentication");
  }
  return reach;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
