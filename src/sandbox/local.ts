/**
 * Runs a template in a child process on this machine.
 *
 * Used for tests, offline work, and as the fallback when a remote sandbox is
 * unavailable. Weaker than a real sandbox - it shares a kernel with the host - but it
 * enforces the same egress allowlist and the same timeout, so a template behaves
 * identically either way.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_SOURCE } from "./guard.js";
import {
  ENTRY_SOURCE,
  RESULT_MARKER,
  type SandboxExecutor,
  type SandboxRequest,
  type SandboxResult,
} from "./types.js";

export class LocalSandbox implements SandboxExecutor {
  readonly kind = "local" as const;

  async run(request: SandboxRequest): Promise<SandboxResult> {
    const dir = await mkdtemp(join(tmpdir(), "contain-sbx-"));
    const startedAt = Date.now();

    try {
      await Promise.all([
        writeFile(join(dir, "guard.cjs"), GUARD_SOURCE, "utf8"),
        writeFile(join(dir, "template.cjs"), request.templateSource, "utf8"),
        writeFile(join(dir, "entry.cjs"), ENTRY_SOURCE, "utf8"),
      ]);

      // Deliberately minimal: the host environment is not inherited, so no ambient
      // credential can leak into a template.
      const env: NodeJS.ProcessEnv = {
        SBX_ALLOW_HOSTS: request.allowHosts.join(","),
        SBX_PARAMS: JSON.stringify(request.params),
        PATH: process.env["PATH"] ?? "",
        ...(process.env["SYSTEMROOT"] ? { SYSTEMROOT: process.env["SYSTEMROOT"] } : {}),
      };

      const { stdout, stderr } = await runChild(dir, env, request.timeoutMs);
      return { ...parseOutput(stdout, stderr), elapsedMs: Date.now() - startedAt, sandboxKind: this.kind };
    } catch (err) {
      const timedOut = (err as { killed?: boolean }).killed === true;
      return {
        ok: false,
        error: timedOut ? `Timed out after ${request.timeoutMs}ms` : String(err),
        stderr: tail((err as { stderr?: string }).stderr ?? ""),
        elapsedMs: Date.now() - startedAt,
        sandboxKind: this.kind,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function runChild(
  dir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--require", join(dir, "guard.cjs"), join(dir, "entry.cjs")],
      { cwd: dir, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        clearTimeout(reaper);
        if (err) reject(Object.assign(err, { stderr }));
        else resolve({ stdout, stderr });
      },
    );

    // execFile's own timeout signals the child but leaves anything it spawned running,
    // so a template that starts a subprocess could outlive the sandbox that was
    // supposed to bound it. Reap the whole tree slightly after execFile gives up.
    const reaper = setTimeout(() => killTree(child.pid), timeoutMs + 500);
    reaper.unref();
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // Windows has no process groups to signal, so ask the OS to walk the tree.
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

/** Extract the single marked result line the entry script prints. */
export function parseOutput(
  stdout: string,
  stderr: string,
): Pick<SandboxResult, "ok" | "value" | "error" | "stderr"> {
  const line = stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
  if (!line) {
    return { ok: false, error: "Sandbox produced no result", stderr: tail(stderr) };
  }
  const parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as {
    ok: boolean;
    value?: unknown;
    error?: string;
  };
  return parsed.ok
    ? { ok: true, value: parsed.value, stderr: tail(stderr) }
    : { ok: false, error: parsed.error ?? "unknown error", stderr: tail(stderr) };
}

function tail(text: string, limit = 800): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? trimmed.slice(-limit) : trimmed;
}
