/** Rebuilds the demo repository from the tokens in .env. */
import { buildFixtureRepo } from "./build.js";

// loadEnvFile throws if the file is absent, which produced a Node stack trace instead
// of the explanation written below for exactly this case.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env. The check below reports what is missing and how to fix it.
}

const live = process.env["FIXTURE_LIVE_GITHUB_PAT"];
const dead = process.env["FIXTURE_DEAD_GITHUB_PAT"];

if (!live || !dead) {
  console.error(
    "Missing FIXTURE_LIVE_GITHUB_PAT or FIXTURE_DEAD_GITHUB_PAT in .env.\n" +
      "See .env.example. Both must come from a throwaway account.",
  );
  process.exit(1);
}

const repo = buildFixtureRepo("fixtures/leaky-service", live, dead);
console.log(`Built fixture repo at ${repo}`);
