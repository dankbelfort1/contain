/** Rebuilds the demo repository from the tokens in .env. */
import { buildFixtureRepo } from "./build.js";

process.loadEnvFile(".env");

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
