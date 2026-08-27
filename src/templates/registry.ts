/**
 * The set of providers we can verify.
 *
 * A finding whose provider has no template is not guessed at. It comes back UNKNOWN
 * and goes to a human, because a wrong DEAD would leave a working credential in place
 * and a wrong LIVE would waste someone's time on a revocation that changes nothing.
 */
import { githubTemplate } from "./github.js";
import type { VerificationTemplate } from "./types.js";

const TEMPLATES: readonly VerificationTemplate[] = [githubTemplate];

/** Every registered template. Used by the safety tests and the audit trail. */
export function allTemplates(): readonly VerificationTemplate[] {
  return TEMPLATES;
}

/** The template for a provider, or undefined when we cannot verify it. */
export function templateForProvider(provider: string): VerificationTemplate | undefined {
  return TEMPLATES.find((t) => t.provider === provider);
}
