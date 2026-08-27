/**
 * contain - command line entry point.
 */
import { readFile } from "node:fs/promises";
import { run } from "./run.js";
import { bold, cyan, dim, statusBadge } from "./render.js";

const USAGE = `${bold("contain")} - investigate leaked credentials, revoke only with approval

  contain run <repository> [options]     run the full loop
  contain audit <file.jsonl>             read back a recorded run
  contain help

Options for run:
  --dry-run            do everything except revoke. Never fires.
  --yes                stop at the gate without prompting (for scripts and CI)
  --audit-dir <dir>    where to write the trail (default: audit)
  --operator <name>    who approvals are attributed to (default: $USER)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }

  if (command === "run") {
    const repositoryPath = rest.find((a) => !a.startsWith("--"));
    if (!repositoryPath) {
      console.error("A repository path is required. See: contain help");
      return 2;
    }
    const state = await run({
      repositoryPath,
      dryRun: rest.includes("--dry-run"),
      nonInteractive: rest.includes("--yes"),
      auditDir: valueOf(rest, "--audit-dir") ?? "audit",
      operator: valueOf(rest, "--operator") ?? process.env["USER"] ?? "operator",
    });
    // Non-zero when something live is still out there, so CI can fail on it.
    const plan = state.plan();
    return plan && plan.summary.live > 0 ? 1 : 0;
  }

  if (command === "audit") {
    const file = rest[0];
    if (!file) {
      console.error("A path to an audit file is required.");
      return 2;
    }
    await printAudit(file);
    return 0;
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(USAGE);
  return 2;
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function printAudit(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  const events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  console.log(bold(cyan(`\n${events.length} events from ${path}\n`)));
  for (const event of events) {
    const at = String(event["at"]).slice(11, 19);
    const type = String(event["type"]);
    let detail = "";

    switch (type) {
      case "finding.discovered":
        detail = `${event["maskedSecret"]} at ${event["location"]}`;
        break;
      case "verification.completed":
        detail = `${statusBadge(event["status"] as never)} ${event["findingId"]}`;
        break;
      case "approval.decided":
        detail = `${event["decision"]} by ${event["decidedBy"]}`;
        break;
      case "revoke.completed":
        detail = `${event["statusBefore"]} to ${event["statusAfter"]}, confirmed=${event["confirmed"]}`;
        break;
      case "action.refused":
        detail = String(event["reason"]);
        break;
      default:
        detail = "";
    }

    console.log(`  ${dim(at)}  ${type.padEnd(24)} ${detail}`);
  }
  console.log();
}

process.exitCode = await main(process.argv.slice(2));
