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
    const parsed = parseRunArgs(rest);
    if ("error" in parsed) {
      console.error(parsed.error);
      console.error("See: contain help");
      return 2;
    }
    const { repositoryPath, dryRun, nonInteractive, auditDir, operator } = parsed;
    const state = await run({ repositoryPath, dryRun, nonInteractive, auditDir, operator });
    // Non-zero when a live credential is still out there. Computed from what actually
    // happened rather than from the plan: a credential that was revoked and confirmed
    // dead is no longer a reason to fail, and reporting it as one would train people
    // to ignore the exit code.
    const plan = state.plan();
    if (!plan) return 0;

    const confirmedDead = new Set(
      state.audit
        .events()
        .filter((e) => e.type === "revoke.completed" && e.confirmed)
        .map((e) => (e as { findingId: string }).findingId),
    );
    const stillLive = plan.items.filter(
      (item) => item.status === "LIVE" && !confirmedDead.has(item.findingId),
    );
    return stillLive.length > 0 ? 1 : 0;
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

const FLAGS = new Set(["--dry-run", "--yes"]);
const OPTIONS = new Set(["--audit-dir", "--operator"]);

interface RunArgs {
  repositoryPath: string;
  dryRun: boolean;
  nonInteractive: boolean;
  auditDir: string;
  operator: string;
}

/**
 * Parse `contain run` arguments.
 *
 * Written out rather than scanning for the first non-flag argument, because that
 * treated an option's value as the repository path: `--operator deep` silently made
 * "deep" the thing to scan. Unknown flags are rejected rather than ignored, since a
 * mistyped `--dry-runn` would otherwise perform a real revocation.
 */
function parseRunArgs(args: string[]): RunArgs | { error: string } {
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let dryRun = false;
  let nonInteractive = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (FLAGS.has(arg)) {
      if (arg === "--dry-run") dryRun = true;
      if (arg === "--yes") nonInteractive = true;
    } else if (OPTIONS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `${arg} needs a value.` };
      }
      values.set(arg, value);
      i++;
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) return { error: "A repository path is required." };
  if (positionals.length > 1) {
    return { error: `Expected one repository path, got: ${positionals.join(", ")}` };
  }

  return {
    repositoryPath: positionals[0] as string,
    dryRun,
    nonInteractive,
    auditDir: values.get("--audit-dir") ?? "audit",
    operator: values.get("--operator") ?? process.env["USER"] ?? "operator",
  };
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
