/**
 * Serves the workflow UI and the API that backs it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApiServer } from "./api.js";

const port = Number(process.env["CONTAIN_UI_PORT"] ?? 8910);
const repositoryPath = process.argv[2] ?? "fixtures/leaky-service";
const dryRun = process.argv.includes("--dry-run");

const built = resolve("dist-ui");
const staticDir = existsSync(built) ? built : undefined;

const server = createApiServer({
  repositoryPath,
  dryRun,
  operator: process.env["CONTAIN_OPERATOR"] ?? process.env["USER"] ?? "operator",
  ...(staticDir ? { staticDir } : {}),
});

// Loopback only. These endpoints approve and revoke credentials with no
// authentication of their own, so exposing them on every interface would hand anyone
// on the network the ability to destroy a credential.
server.listen(port, "127.0.0.1", () => {
  console.log(`ContAIn UI on http://localhost:${port}`);
  console.log(`  repository: ${repositoryPath}`);
  console.log(`  dry run:    ${dryRun}`);
  if (!staticDir) {
    console.log("\n  UI not built yet. Either:");
    console.log("    npm run ui:build   then reload this page");
    console.log("    npm run ui:dev     for the dev server on :5173");
  }
});
