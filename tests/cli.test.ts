import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dim, padVisible, safe, wrap } from "../src/cli/render.js";
import { run } from "../src/cli/run.js";
import { buildFixtureRepo } from "../src/fixtures/build.js";
import type { SandboxExecutor, SandboxResult } from "../src/sandbox/types.js";

const STANDIN_LIVE = "ghp_eY3unNM0ej2DTUg2AoqRvFbepiJ0YcRMTaub";
const STANDIN_DEAD = "ghp_uUhL0xZGDioM3VcdwKrb58CB6A1Rqa4es8j7";

/**
 * Sandbox that reports the stand-in live token as live and everything else as dead,
 * so the loop can be exercised end to end without touching the network.
 */
const scriptedSandbox: SandboxExecutor = {
  kind: "local",
  async run(request): Promise<SandboxResult> {
    const token = String((request.params as { token?: unknown }).token ?? "");
    const live = token === STANDIN_LIVE;
    return {
      ok: true,
      value: {
        status: live ? "LIVE" : "DEAD",
        httpStatus: live ? 200 : 401,
        principal: live ? "Dank-Burner" : undefined,
        capabilities: live ? ["repo", "delete_repo"] : [],
        facts: live ? { publicRepos: 1, twoFactorEnabled: false } : {},
      },
      stderr: "",
      elapsedMs: 2,
      sandboxKind: "local",
    };
  },
};

let workDir: string;
let repo: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "contain-cli-"));
  repo = buildFixtureRepo(join(workDir, "leaky-service"), STANDIN_LIVE, STANDIN_DEAD);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function options(overrides: Partial<Parameters<typeof run>[0]> = {}) {
  return {
    repositoryPath: repo,
    dryRun: true,
    nonInteractive: true,
    auditDir: join(workDir, "audit"),
    operator: "test",
    sandbox: scriptedSandbox,
    ...overrides,
  };
}

describe("the full loop", () => {
  it("investigates everything and stops at the gate without approval", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = await run(options());
      const plan = state.plan();

      expect(plan?.summary).toMatchObject({ total: 3, live: 1, dead: 2, awaitingApproval: 1 });

      // The gate was reached and refused, and nothing was revoked.
      const types = state.audit.events().map((e) => e.type);
      expect(types).toContain("approval.requested");
      expect(types).toContain("approval.decided");
      expect(types).not.toContain("revoke.completed");
    } finally {
      log.mockRestore();
    }
  });

  it("writes an audit trail with no credential in it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = await run(options());
      const path = join(workDir, "audit", `${state.runId}.jsonl`);
      const text = await readFile(path, "utf8");

      expect(text).not.toContain(STANDIN_LIVE);
      expect(text).not.toContain(STANDIN_DEAD);

      const lines = text.trim().split("\n");
      expect(lines.length).toBeGreaterThan(8);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("records a denial rather than silently skipping", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = await run(options());
      const decisions = state.audit.events().filter((e) => e.type === "approval.decided");

      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ decision: "deny", decidedBy: "test" });
    } finally {
      log.mockRestore();
    }
  });
});

describe("replay determinism", () => {
  it("produces identical findings, statuses, and plan on a second run", async () => {
    // The claim: same repository, same state, same answer. Without this, an audit
    // trail is a story rather than a record.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = await run(options());
      const second = await run(options());

      const shape = (s: Awaited<ReturnType<typeof run>>) =>
        s.plan()?.items.map((i) => ({
          id: i.findingId,
          status: i.status,
          action: i.action,
          reason: i.reason,
          masked: i.maskedSecret,
          blastRadius: i.blastRadius,
        }));

      expect(shape(second)).toEqual(shape(first));
    } finally {
      log.mockRestore();
    }
  });

  it("assigns a distinct run id each time, so trails do not overwrite each other", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = await run(options());
      const second = await run(options());
      expect(second.runId).not.toBe(first.runId);
    } finally {
      log.mockRestore();
    }
  });
});

describe("render helpers", () => {
  it("pads to a visible width, ignoring colour codes", () => {
    // Built explicitly rather than via the colour helpers: under vitest stdout is not
    // a TTY, so those return plain text and this test would pass without ever
    // exercising the thing it claims to check.
    const esc = "\u001b";
    const coloured = `${esc}[31m${esc}[1mabc${esc}[0m`;

    expect(padVisible("abc", 10)).toHaveLength(10);
    // Three visible columns, so seven spaces are added regardless of the escapes.
    expect(padVisible(coloured, 10)).toBe(coloured + " ".repeat(7));
  });

  it("strips control characters from repository-derived text", () => {
    // A commit message is not ours. Printed raw it could repaint the approval panel to
    // say something other than what is about to happen, and the gate is only
    // meaningful if it cannot be forged.
    const hostile = "innocent\u001b[2J\u001b[HREVOKING NOTHING\r\u0007";
    const cleaned = safe(hostile);

    expect(cleaned).not.toContain("\u001b");
    expect(cleaned).not.toContain("\r");
    expect(cleaned).not.toContain("\u0007");
    expect(cleaned).toContain("innocent");
  });

  it("strips bidirectional overrides and invisible characters", () => {
    // Stripping the C0 range alone is not enough. These reorder what a terminal
    // displays, so a commit message can render as something other than it contains.
    const trojan = "revoke\u202Enothing\u202C\u200Bhidden\uFEFF";
    const cleaned = safe(trojan);

    for (const cp of ["\u202E", "\u202C", "\u200B", "\uFEFF"]) {
      expect(cleaned).not.toContain(cp);
    }
    expect(cleaned).toBe("revokenothinghidden");
  });

  it("leaves ordinary text alone", () => {
    expect(safe('Add deploy config for "staging" - v2')).toBe('Add deploy config for "staging" - v2');
  });

  it("never truncates when the text already exceeds the width", () => {
    expect(padVisible("a".repeat(20), 5)).toBe("a".repeat(20));
  });

  it("wraps prose on word boundaries", () => {
    const lines = wrap("the agent earns information not permissions", 0, 20);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toContain("permissions");
  });

  it("indents wrapped prose consistently", () => {
    const lines = wrap("one two three four five six seven eight nine", 4, 24);
    for (const line of lines) expect(line.startsWith("    ")).toBe(true);
  });

  it("dim leaves text readable when colour is disabled", () => {
    // NO_COLOR is set in CI, and the panel must still line up.
    expect(dim("x").includes("x")).toBe(true);
  });
});
