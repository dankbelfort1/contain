import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSandbox } from "../src/sandbox/local.js";
import { startHttpServer } from "../src/mcp/server.js";
import { RunState } from "../src/mcp/state.js";

let http: HttpServer;
let client: Client;

beforeAll(async () => {
  http = await startHttpServer(
    {
      state: new RunState(),
      sandbox: new LocalSandbox(),
      operator: "test",
      dryRun: true,
    },
    0,
  );
  const { port } = http.address() as AddressInfo;

  client = new Client({ name: "contain-test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)) as never,
  );
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("annotations as published over MCP", () => {
  // Asserting the annotations in our own module proves what we wrote. This proves
  // what a client actually receives, which is what TrueForge resolves "@destructive"
  // against. If the SDK ever dropped annotations in transit, the gate would silently
  // stop existing and only this test would notice.

  it("publishes all five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "build_remediation_plan",
      "read_audit_trail",
      "revoke_credential",
      "scan_repository",
      "verify_credential",
    ]);
  });

  it("marks exactly one published tool destructive", async () => {
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);

    expect(destructive.map((t) => t.name)).toEqual(["revoke_credential"]);
  });

  it("marks every other published tool read-only", async () => {
    const { tools } = await client.listTools();

    for (const t of tools) {
      if (t.name === "revoke_credential") continue;
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("carries a description a human can read at the approval prompt", async () => {
    const { tools } = await client.listTools();
    const revoke = tools.find((t) => t.name === "revoke_credential");

    expect(revoke?.description).toContain("cannot be undone");
  });
});
