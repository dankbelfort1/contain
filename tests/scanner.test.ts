import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixtureRepo, FAKE_TOKEN } from "../src/fixtures/build.js";
import { detectProvider, scanRepository, ScannerError } from "../src/tools/scanner.js";
import { redact } from "../src/types.js";

// Synthetic, never-issued tokens. Tests must not depend on .env or reach any network.
const STANDIN_LIVE = "ghp_eY3unNM0ej2DTUg2AoqRvFbepiJ0YcRMTaub";
const STANDIN_DEAD = "ghp_uUhL0xZGDioM3VcdwKrb58CB6A1Rqa4es8j7";

let workDir: string;
let repo: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "contain-test-"));
  repo = buildFixtureRepo(join(workDir, "leaky-service"), STANDIN_LIVE, STANDIN_DEAD);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("scanRepository", () => {
  it("finds every planted credential", async () => {
    const findings = await scanRepository(repo);
    const secrets = findings.map((f) => f.secret);

    expect(secrets).toContain(STANDIN_LIVE);
    expect(secrets).toContain(STANDIN_DEAD);
    expect(secrets).toContain(FAKE_TOKEN);
  });

  it("finds a secret that was deleted from the working tree", async () => {
    // The live token's file is removed in a later commit, so it exists only in
    // history. This is the case that a working-tree-only scan would miss, and the
    // reason we scan git history at all.
    const findings = await scanRepository(repo);
    const historyOnly = findings.find((f) => f.secret === STANDIN_LIVE);

    expect(historyOnly).toBeDefined();
    expect(historyOnly?.file).toBe("deploy/staging.yml");
    expect(historyOnly?.commitMessage).toBe("Add deploy config for staging");
  });

  it("attributes each finding to a commit and an author", async () => {
    const findings = await scanRepository(repo);

    for (const finding of findings) {
      expect(finding.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(finding.email).toBe("priya@leaky-service.example");
      expect(finding.id).toContain(finding.commit);
    }
  });

  it("routes GitHub tokens to the github provider", async () => {
    const findings = await scanRepository(repo);
    expect(findings.every((f) => f.provider === "github")).toBe(true);
  });

  it("returns no findings for a clean repository, rather than failing", async () => {
    // gitleaks writes an empty JSON array when it finds nothing. This distinguishes
    // a genuinely clean repository from an unreadable report, which must raise.
    const clean = join(workDir, "clean-repo");
    mkdirSync(clean, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: clean });
    writeFileSync(join(clean, "a.txt"), "nothing sensitive here");
    execFileSync("git", ["add", "-A"], { cwd: clean });
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "clean"], {
      cwd: clean,
    });

    await expect(scanRepository(clean)).resolves.toEqual([]);
  });

  it("rejects a path that is not a git repository", async () => {
    await expect(scanRepository(workDir)).rejects.toBeInstanceOf(ScannerError);
  });

  it("is deterministic: the same repository yields the same findings", async () => {
    const first = await scanRepository(repo);
    const second = await scanRepository(repo);
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
  });
});

describe("buildFixtureRepo", () => {
  it("produces identical commit hashes for identical inputs", async () => {
    const other = buildFixtureRepo(join(workDir, "rebuild"), STANDIN_LIVE, STANDIN_DEAD);
    const a = await scanRepository(repo);
    const b = await scanRepository(other);

    // Fixed author and commit timestamps mean the hashes must match exactly.
    expect(b.map((f) => f.commit).sort()).toEqual(a.map((f) => f.commit).sort());
  });
});

describe("detectProvider", () => {
  it.each([
    ["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "github"],
    ["github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "github"],
    ["gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "github"],
  ])("maps %s to %s", (secret, expected) => {
    expect(detectProvider("some-rule", secret)).toBe(expected);
  });

  it("returns unknown when no template can handle the secret", () => {
    // Must not guess. Unknown means a human looks at it.
    expect(detectProvider("generic-api-key", "xoxb-slack-style-token")).toBe("unknown");
  });
});

describe("redact", () => {
  it("keeps the provider prefix and the last four characters", () => {
    const masked = redact("ghp_eY3unNM0ej2DTUg2AoqRvFbepiJ0YcRMTaub");
    expect(masked.startsWith("ghp_")).toBe(true);
    expect(masked.endsWith("Taub")).toBe(true);
    expect(masked).not.toContain("eY3unNM0");
  });

  it("reveals nothing about a short value", () => {
    expect(redact("abc123")).toBe("******");
  });
});
