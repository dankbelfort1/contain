import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalSandbox } from "../src/sandbox/local.js";

const sandbox = new LocalSandbox();
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reached: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("LocalSandbox", () => {
  it("runs a template and returns its value", async () => {
    const result = await sandbox.run({
      templateSource: "exports.run = async (params) => ({ hello: params.name });",
      params: { name: "ContAIn" },
      allowHosts: [],
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ hello: "ContAIn" });
    expect(result.sandboxKind).toBe("local");
  });

  it("reaches a host on the allowlist", async () => {
    const result = await sandbox.run({
      templateSource:
        "exports.run = async (p) => { const r = await fetch('http://localhost:' + p.port + '/'); return await r.json(); };",
      params: { port },
      allowHosts: ["localhost"],
      timeoutMs: 15_000,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ reached: true });
  });

  it("blocks a host that is not on the allowlist", async () => {
    // The safety invariant: verification cannot reach anywhere it was not sent.
    const result = await sandbox.run({
      templateSource:
        "exports.run = async () => { const r = await fetch('https://example.com/'); return { leaked: r.status }; };",
      params: {},
      allowHosts: ["localhost"],
      timeoutMs: 15_000,
    });

    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it("blocks every host when the allowlist is empty", async () => {
    const result = await sandbox.run({
      templateSource:
        "exports.run = async (p) => { const r = await fetch('http://localhost:' + p.port + '/'); return { leaked: r.status }; };",
      params: { port },
      allowHosts: [],
      timeoutMs: 15_000,
    });

    expect(result.ok).toBe(false);
  });

  it("kills a template that overruns its timeout", async () => {
    const result = await sandbox.run({
      // A pending promise alone would let Node exit with an empty event loop, so
      // hold a live timer to genuinely hang the template.
      templateSource:
        "exports.run = () => new Promise((resolve) => setTimeout(resolve, 60000));",
      params: {},
      allowHosts: [],
      timeoutMs: 1_500,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Timed out");
  });

  it("does not inherit the host environment", async () => {
    // A template must never read credentials that happen to sit in the environment
    // of the process that launched it.
    process.env["CONTAIN_TEST_HOST_SECRET"] = "must-not-be-visible";
    try {
      const result = await sandbox.run({
        templateSource:
          "exports.run = async () => ({ leaked: process.env.CONTAIN_TEST_HOST_SECRET ?? null });",
        params: {},
        allowHosts: [],
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ leaked: null });
    } finally {
      delete process.env["CONTAIN_TEST_HOST_SECRET"];
    }
  });

  it("reports a template that throws, without crashing the caller", async () => {
    const result = await sandbox.run({
      templateSource: "exports.run = async () => { throw new Error('template blew up'); };",
      params: {},
      allowHosts: [],
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("template blew up");
  });
});
