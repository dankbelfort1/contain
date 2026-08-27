/**
 * Wraps gitleaks. We do not write secret-detection regexes ourselves - detection is a
 * solved problem and a hand-rolled scanner would be worse than the standard tool.
 *
 * Scans full git history, not just the working tree. Most real leaks are credentials
 * that were committed once and later deleted, so they are invisible in current code.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Finding } from "../types.js";

const execFileAsync = promisify(execFile);

/** One entry of gitleaks' JSON report. Field names are gitleaks', not ours. */
interface GitleaksFinding {
  RuleID: string;
  Secret: string;
  File: string;
  StartLine: number;
  Commit: string;
  Author: string;
  Email: string;
  Date: string;
  Message: string;
  /** gitleaks' own stable id: "commit:file:ruleid:startline". */
  Fingerprint: string;
}

export class ScannerError extends Error {}

/** Locate the gitleaks binary: the vendored copy first, then PATH. */
export function resolveGitleaksPath(): string {
  const vendored = resolve("bin", process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
  if (existsSync(vendored)) return vendored;
  return process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
}

/**
 * Map a finding to the provider whose verification templates can handle it.
 * Returns "unknown" when we have no template, which the agent must treat as
 * needing manual review rather than guessing.
 */
export function detectProvider(ruleId: string, secret: string): string {
  if (/^(ghp_|github_pat_|gho_|ghu_|ghr_)/.test(secret)) return "github";
  if (ruleId.startsWith("github")) return "github";
  return "unknown";
}

/**
 * Scan a repository's full history for credentials.
 *
 * @param repoPath Path to the git repository to scan.
 * @returns Findings in the order gitleaks reported them.
 */
export async function scanRepository(repoPath: string): Promise<Finding[]> {
  const repo = resolve(repoPath);
  if (!existsSync(join(repo, ".git"))) {
    throw new ScannerError(`Not a git repository: ${repo}`);
  }

  // mkdtemp creates the directory atomically with owner-only permissions. A
  // predictable path in the shared temp directory would let a local user pre-create
  // it as a symlink, which gitleaks would follow and truncate, and would also let two
  // concurrent scans overwrite each other's report.
  const reportDir = await mkdtemp(join(tmpdir(), "contain-scan-"));
  const reportPath = join(reportDir, "report.json");

  try {
    try {
      await execFileAsync(
        resolveGitleaksPath(),
        [
          "git",
          repo,
          "--report-format", "json",
          "--report-path", reportPath,
          "--no-banner",
          "--log-level", "error",
          // Findings are the expected outcome, not a failure. Without this gitleaks
          // exits 1 whenever it finds anything, which would look like a crash.
          "--exit-code", "0",
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (cause) {
      throw new ScannerError(
        `gitleaks failed to run. Is it installed at ${resolveGitleaksPath()}? ` +
          `Run \`npm run setup\` to fetch it. Cause: ${String(cause)}`,
      );
    }

    let raw: string;
    try {
      raw = await readFile(reportPath, "utf8");
    } catch (cause) {
      // gitleaks writes the report file even when it finds nothing - an empty JSON
      // array. So an unreadable report after a successful run means something went
      // wrong, not that the repository is clean. Returning [] here would turn a
      // permissions or filesystem failure into a silent "no secrets found", which is
      // the most dangerous way this tool could fail.
      throw new ScannerError(
        `gitleaks exited successfully but its report could not be read: ${String(cause)}`,
      );
    }

    try {
      const parsed = JSON.parse(raw) as GitleaksFinding[] | null;
      if (!Array.isArray(parsed)) {
        throw new ScannerError(`Expected a JSON array from gitleaks, got ${typeof parsed}`);
      }
      return parsed.map(toFinding).sort(byStableOrder);
    } catch (cause) {
      if (cause instanceof ScannerError) throw cause;
      throw new ScannerError(`Could not parse the gitleaks report: ${String(cause)}`);
    }
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

/**
 * Order findings deterministically.
 *
 * gitleaks walks history concurrently and does not promise a stable order, so two
 * scans of an unchanged repository can return the same findings in different
 * sequences. Replay depends on identical input producing identical output, so we
 * impose our own total order: oldest leak first, then by location.
 */
function byStableOrder(a: Finding, b: Finding): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toFinding(raw: GitleaksFinding): Finding {
  return {
    id: raw.Fingerprint,
    provider: detectProvider(raw.RuleID, raw.Secret),
    ruleId: raw.RuleID,
    secret: raw.Secret,
    file: raw.File,
    startLine: raw.StartLine,
    commit: raw.Commit,
    author: raw.Author,
    email: raw.Email,
    date: raw.Date,
    commitMessage: raw.Message.split("\n")[0]?.trim() ?? "",
  };
}
