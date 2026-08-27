import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixtureRepo } from "../src/fixtures/build.js";
import { createApiServer } from "../src/server/api.js";
import type { SandboxExecutor, SandboxResult } from "../src/sandbox/types.js";

const STANDIN_LIVE = "ghp_eY3unNM0ej2DTUg2AoqRvFbepiJ0YcRMTaub";
const STANDIN_DEAD = "ghp_uUhL0xZGDioM3VcdwKrb58CB6A1Rqa4es8j7";

const scriptedSandbox: SandboxExecutor = {
  kind: "local",
  async run(request): Promise<SandboxResult> {
    const live = String((request.params as { token?: unknown }).token) === STANDIN_LIVE;
    return {
      ok: true,
      value: {
        status: live ? "LIVE" : "DEAD",
        httpStatus: live ? 200 : 401,
        principal: live ? "Dank-Burner" : undefined,
        capabilities: live ? ["repo", "delete_repo"] : [],
        facts: {},
      },
      stderr: "",
      elapsedMs: 2,
      sandboxKind: "local",
    };
  },
};

let workDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "contain-api-"));
  const repo = buildFixtureRepo(join(workDir, "leaky-service"), STANDIN_LIVE, STANDIN_DEAD);

  server = createApiServer({
    repositoryPath: repo,
    // Dry run: this suite must never be able to fire a real revoke, whatever it does.
    dryRun: true,
    operator: "test",
    sandbox: scriptedSandbox,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

async function post(path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

describe("the API drives the same loop as the CLI", () => {
  it("scans, verifies, and plans", async () => {
    await post("/api/reset");
    const scanned = await post("/api/scan");
    expect(scanned.body["findings"]).toHaveLength(3);

    const verified = await post("/api/verify");
    const statuses = (verified.body["verifications"] as unknown as { status: string }[]).map(
      (v) => v.status,
    );
    expect(statuses.filter((s) => s === "LIVE")).toHaveLength(1);

    const planned = await post("/api/plan");
    expect((planned.body["plan"] as unknown as { summary: { awaitingApproval: number } }).summary
      .awaitingApproval).toBe(1);
    expect(planned.body["stage"]).toBe("awaiting_approval");
  });
});

describe("the gate is server-side, not in the browser", () => {
  async function reachTheGate() {
    await post("/api/reset");
    await post("/api/scan");
    await post("/api/verify");
    const planned = await post("/api/plan");
    const items = planned.body["plan"] as unknown as { items: { findingId: string; requiresApproval: boolean }[] };
    return items.items.find((i) => i.requiresApproval)!.findingId;
  }

  it("refuses revoke before anyone has approved", async () => {
    const findingId = await reachTheGate();
    const res = await post("/api/revoke", { findingId });

    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toMatch(/Human approval required/);
  });

  it("records the refusal in the audit trail", async () => {
    const findingId = await reachTheGate();
    const res = await post("/api/revoke", { findingId });
    const audit = (res.body["state"] as unknown as { audit: { type: string }[] }).audit;

    expect(audit.some((e) => e.type === "action.refused")).toBe(true);
  });

  it("ignores an approval token supplied by the client", async () => {
    // The revoke path reads the token from the server-side registry, never from the
    // request body. If a caller could hand one over, the gate would be client-side
    // and therefore no gate at all.
    const findingId = await reachTheGate();
    const res = await post("/api/revoke", {
      findingId,
      approvalToken: "attacker-supplied",
      approved: true,
      decision: "allow",
    });

    expect(res.status).toBe(403);
  });

  it("proceeds only after an approval is granted through the API", async () => {
    const findingId = await reachTheGate();
    await post("/api/approve", { findingId, decision: "allow" });
    const res = await post("/api/revoke", { findingId });

    expect(res.status).toBe(200);
    const audit = (res.body["audit"] as unknown as { type: string; dryRun?: boolean }[]).filter(
      (e) => e.type === "revoke.completed",
    );
    expect(audit).toHaveLength(1);
    // Dry run, so it recorded the decision without firing.
    expect(audit[0]?.dryRun).toBe(true);
  });

  it("refuses after a denial", async () => {
    const findingId = await reachTheGate();
    await post("/api/approve", { findingId, decision: "deny" });
    const res = await post("/api/revoke", { findingId });

    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toMatch(/denied/i);
  });
});

describe("approval cannot skip the investigation", () => {
  it("refuses an approval before a plan exists", async () => {
    // Otherwise a caller could scan, approve and revoke while skipping verification
    // and the blast radius, which are the reason the decision is asked of a human.
    await post("/api/reset");
    const scanned = await post("/api/scan");
    const findingId = (scanned.body["findings"] as unknown as { findingId: string }[])[0]!
      .findingId;

    const res = await post("/api/approve", { findingId, decision: "allow" });
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toMatch(/No plan has been built/);
  });

  it("refuses an approval for a finding the plan does not propose acting on", async () => {
    await post("/api/reset");
    await post("/api/scan");
    await post("/api/verify");
    const planned = await post("/api/plan");
    const items = planned.body["plan"] as unknown as {
      items: { findingId: string; requiresApproval: boolean }[];
    };
    const dead = items.items.find((i) => !i.requiresApproval)!;

    const res = await post("/api/approve", { findingId: dead.findingId, decision: "allow" });
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toMatch(/nothing to approve/);
  });

  it("rejects a malformed decision instead of recording it as a denial", async () => {
    await post("/api/reset");
    await post("/api/scan");
    await post("/api/verify");
    const planned = await post("/api/plan");
    const items = planned.body["plan"] as unknown as {
      items: { findingId: string; requiresApproval: boolean }[];
    };
    const gated = items.items.find((i) => i.requiresApproval)!;

    const res = await post("/api/approve", { findingId: gated.findingId, decision: "maybe" });
    expect(res.status).toBe(400);
  });
});

describe("the API never returns a credential", () => {
  it("omits secrets from every response", async () => {
    await post("/api/reset");
    await post("/api/scan");
    await post("/api/verify");
    const planned = await post("/api/plan");

    const serialised = JSON.stringify(planned.body);
    expect(serialised).not.toContain(STANDIN_LIVE);
    expect(serialised).not.toContain(STANDIN_DEAD);
  });
});
