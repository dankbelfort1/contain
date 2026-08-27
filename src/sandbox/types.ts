/** The contract every sandbox implementation satisfies. */

export interface SandboxRequest {
  /** Source of a vetted template exposing `async function run(params)`. */
  templateSource: string;
  /** Parameters the template needs, including the credential under test. */
  params: Record<string, unknown>;
  /** Hosts the template may reach. Everything else is blocked. */
  allowHosts: string[];
  timeoutMs: number;
}

export interface SandboxResult {
  /** True when the template returned; false when it threw or was killed. */
  ok: boolean;
  /** Whatever the template returned. Shape is the template's business. */
  value?: unknown;
  /** Present when ok is false. */
  error?: string;
  /** Trailing stderr, truncated. Useful for diagnosing a blocked connection. */
  stderr: string;
  elapsedMs: number;
  /** Which implementation ran this, recorded in the audit trail. */
  sandboxKind: SandboxKind;
  /** Provider-side identifier, when the implementation has one. */
  sandboxId?: string;
}

export type SandboxKind = "local" | "daytona";

export interface SandboxExecutor {
  readonly kind: SandboxKind;
  run(request: SandboxRequest): Promise<SandboxResult>;
}

/** Marker the sandbox entry script uses to separate its result from any other output. */
export const RESULT_MARKER = "__CONTAIN_RESULT__";

/**
 * Entry script run inside the sandbox. Waits for the guard's allowlist to resolve,
 * calls the template, and prints exactly one marked JSON line.
 */
export const ENTRY_SOURCE = String.raw`
'use strict';
const MARKER = '${RESULT_MARKER}';
(async () => {
  let payload;
  try {
    await global.__sandboxReady;
    const template = require('./template.cjs');
    const params = JSON.parse(process.env.SBX_PARAMS || '{}');
    payload = { ok: true, value: await template.run(params) };
  } catch (err) {
    payload = { ok: false, error: String((err && err.message) || err) };
  }
  process.stdout.write(MARKER + JSON.stringify(payload) + '\n');
})();
`;
