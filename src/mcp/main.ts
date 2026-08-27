/**
 * Runs the ContAIn MCP server so TrueForge can connect to it.
 *
 * Point TrueForge at http://localhost:<port>/mcp under Settings, Connectors.
 */
import { LocalSandbox } from "../sandbox/local.js";
import { startHttpServer } from "./server.js";
import { RunState } from "./state.js";
import { TOOLS } from "./tools.js";

// 8900 rather than TrueForge's own 8790, so both can run side by side.
const port = Number(process.env["CONTAIN_MCP_PORT"] ?? 8900);

async function main(): Promise<void> {
  const deps = {
    state: new RunState(),
    sandbox: new LocalSandbox(),
    operator: process.env["CONTAIN_OPERATOR"] ?? "operator",
    dryRun: process.env["CONTAIN_DRY_RUN"] === "true",
    // Only set this when the harness connecting to this server is configured to
    // require approval for destructive tools. Setting it otherwise removes the gate.
    harnessGatesDestructiveTools: process.env["CONTAIN_HARNESS_GATES_DESTRUCTIVE"] === "true",
  };

  await startHttpServer(deps, port);

  console.log(`ContAIn MCP server listening on http://localhost:${port}/mcp`);
  console.log(`dry run: ${deps.dryRun}`);
  console.log(
    deps.harnessGatesDestructiveTools
      ? "approval:  delegated to the harness (CONTAIN_HARNESS_GATES_DESTRUCTIVE=true)"
      : "approval:  an approval token bound to the credential is required",
  );
  console.log("\ntools:");
  for (const tool of TOOLS) {
    const gate = tool.annotations.destructiveHint ? "DESTRUCTIVE, needs approval" : "read-only";
    console.log(`  ${tool.name.padEnd(24)} ${gate}`);
  }
}

await main();
