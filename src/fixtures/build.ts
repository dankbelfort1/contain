/**
 * Builds the demo repository: a plausible service with three credentials planted
 * across its git history.
 *
 * The interesting one is the live key. It is committed and then deleted in a later
 * commit, so it does not appear anywhere in the current working tree. Only a scan of
 * full git history finds it - which is the case for most real credential leaks.
 *
 * Secrets are read from the environment, never hardcoded, and the output directory is
 * gitignored. Commit timestamps and author are fixed so the same inputs always produce
 * the same commit hashes, which is what makes replay reproducible.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const AUTHOR = "Priya Raman";
const EMAIL = "priya@leaky-service.example";

/**
 * A GitHub PAT that was never issued. Verification must classify it DEAD.
 *
 * Deliberately high-entropy: gitleaks applies an entropy filter, so an obviously
 * patterned value like "ghp_0F4kE0F4kE..." is silently skipped and never reaches
 * the agent at all. Confirmed to return 401 from the GitHub API.
 */
export const FAKE_TOKEN = "ghp_pgtHOfqoSdLyxKDtWAWN42EMlCIb7Uiy1KOc";

interface PlannedCommit {
  message: string;
  /** ISO timestamp, fixed so hashes are reproducible. */
  date: string;
  /** Files to write before committing. */
  write?: Record<string, string>;
  /** Paths to delete before committing. */
  remove?: string[];
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "pipe",
    env: { ...process.env, ...env },
  });
}

function writeFile(repo: string, relPath: string, content: string): void {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function plan(liveToken: string, deadToken: string): PlannedCommit[] {
  return [
    {
      message: "Initial commit",
      date: "2026-01-08T09:14:00+00:00",
      write: {
        "README.md": "# leaky-service\n\nBilling reconciliation worker.\n",
        "package.json": JSON.stringify(
          { name: "leaky-service", version: "0.1.0", private: true },
          null,
          2,
        ) + "\n",
        "src/index.js":
          "const { reconcile } = require('./reconcile');\n\nreconcile().catch((err) => {\n  console.error(err);\n  process.exit(1);\n});\n",
        "src/reconcile.js":
          "async function reconcile() {\n  // TODO: pull settlement batches\n  return [];\n}\n\nmodule.exports = { reconcile };\n",
      },
    },
    {
      message: "Add deploy config for staging",
      date: "2026-01-14T16:41:00+00:00",
      write: {
        // The live credential. Removed again two commits later.
        "deploy/staging.yml":
          "environment: staging\nregion: eu-west-1\n\n" +
          "# temporary until we get the vault set up\n" +
          `github_token: ${liveToken}\n`,
      },
    },
    {
      message: "Add CI workflow",
      date: "2026-01-15T11:02:00+00:00",
      write: {
        ".github/workflows/ci.yml":
          "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n" +
          "      - uses: actions/checkout@v4\n      - run: npm test\n" +
          `        env:\n          GH_TOKEN: ${FAKE_TOKEN}\n`,
      },
    },
    {
      message: "Move deploy secrets to environment variables",
      date: "2026-01-22T10:27:00+00:00",
      // The live token disappears from the working tree here, but stays in history.
      remove: ["deploy/staging.yml"],
      write: {
        "deploy/staging.yml.example":
          "environment: staging\nregion: eu-west-1\ngithub_token: ${GITHUB_TOKEN}\n",
      },
    },
    {
      message: "Add integration test helper",
      date: "2026-02-03T14:55:00+00:00",
      write: {
        "test/helpers.js":
          "// Shared fixtures for integration tests.\n" +
          `const LEGACY_TOKEN = '${deadToken}';\n\n` +
          "module.exports = { LEGACY_TOKEN };\n",
      },
    },
  ];
}

export function buildFixtureRepo(targetDir: string, liveToken: string, deadToken: string): string {
  const repo = resolve(targetDir);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });

  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["config", "user.name", AUTHOR]);
  git(repo, ["config", "user.email", EMAIL]);
  git(repo, ["config", "commit.gpgsign", "false"]);

  for (const step of plan(liveToken, deadToken)) {
    for (const [relPath, content] of Object.entries(step.write ?? {})) {
      writeFile(repo, relPath, content);
    }
    for (const relPath of step.remove ?? []) {
      git(repo, ["rm", "--quiet", relPath]);
    }
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", step.message], {
      GIT_AUTHOR_DATE: step.date,
      GIT_COMMITTER_DATE: step.date,
      GIT_AUTHOR_NAME: AUTHOR,
      GIT_AUTHOR_EMAIL: EMAIL,
      GIT_COMMITTER_NAME: AUTHOR,
      GIT_COMMITTER_EMAIL: EMAIL,
    });
  }

  return repo;
}
