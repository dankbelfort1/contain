/**
 * Verification templates.
 *
 * The model does not write probe code. It picks a template by provider and supplies
 * parameters; the template itself is fixed source, reviewed once and unchanged at
 * runtime. That is what makes live/dead classification reproducible, and it is why the
 * sandbox's threat model can be "a template with a bug" rather than "a template that
 * is an attacker".
 */
import type { SecretStatus } from "../types.js";

export interface VerificationTemplate {
  /** Stable id, recorded in the audit trail so a run can be reproduced. */
  id: string;
  provider: string;
  /** What the template does, in plain words, for the audit trail and the UI. */
  description: string;
  /** The only hosts the sandbox will permit this template to reach. */
  allowHosts: string[];
  timeoutMs: number;
  /** Vetted source. Must expose `async function run(params)` and only ever read. */
  source: string;
}

/** What a template reports back after running in the sandbox. */
export interface VerificationOutcome {
  status: SecretStatus;
  /** HTTP status observed, when there was one. */
  httpStatus?: number | undefined;
  /** Identity the credential resolves to, e.g. a GitHub login. */
  principal?: string | undefined;
  /** Raw capability strings from the provider, e.g. OAuth scopes. */
  capabilities: string[];
  /** Provider-specific read-only facts used to describe the blast radius. */
  facts: Record<string, unknown>;
}

/**
 * HTTP methods a verification template is permitted to use.
 *
 * Enforced by test against every registered template's source. Verification exists to
 * observe, never to change anything - a probe that could write would make the whole
 * "investigate freely, act only with approval" split meaningless.
 */
export const READ_ONLY_METHODS = ["GET", "HEAD"] as const;
