/**
 * The full remediation loop, driven from a terminal.
 *
 * Discover, verify, assess, plan, stop. Then, only if a human says so, revoke and
 * confirm. The stop is the part worth watching, so everything before it is rendered
 * to make clear how much the agent did without needing anyone's permission, and how
 * completely it halts when it reaches the one thing it cannot do.
 */
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { buildPlan, type PlanItem } from "../agent/plan.js";
import { LocalSandbox } from "../sandbox/local.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import { RunState } from "../mcp/state.js";
import { ApprovalError } from "../policy/approval.js";
import { scanRepository } from "../tools/scanner.js";
import { revokeCredential } from "../tools/revoke.js";
import { verifyAll } from "../tools/verify.js";
import { redact } from "../types.js";
import {
  bold,
  cyan,
  dim,
  green,
  heading,
  red,
  renderApprovalGate,
  renderPlanItem,
  renderVerification,
  rule,
  yellow,
} from "./render.js";

export interface RunOptions {
  repositoryPath: string;
  /** Never fires a real revoke. Used for rehearsals and replay. */
  dryRun: boolean;
  /** Skip the interactive prompt and stop at the gate. */
  nonInteractive: boolean;
  auditDir: string;
  operator: string;
  sandbox?: SandboxExecutor;
}

export async function run(options: RunOptions): Promise<RunState> {
  const state = new RunState();
  const sandbox = options.sandbox ?? new LocalSandbox();
  const startedAt = Date.now();

  console.log(bold(cyan("\nContAIn")) + dim("  the agent earns information, not permissions"));
  if (options.dryRun) console.log(yellow(bold("  DRY RUN: no credential will be revoked")));

  // 1. Discover
  console.log(heading("1/6", "Scan repository and full git history"));
  console.log(dim(`  scanner: gitleaks  target: ${options.repositoryPath}`));
  const findings = await scanRepository(options.repositoryPath);
  state.setFindings(options.repositoryPath, findings);

  state.audit.record({
    type: "run.started",
    at: new Date().toISOString(),
    runId: state.runId,
    repository: options.repositoryPath,
    dryRun: options.dryRun,
  });
  state.audit.record({
    type: "scan.completed",
    at: new Date().toISOString(),
    scanner: "gitleaks",
    findingCount: findings.length,
  });
  for (const finding of findings) state.audit.recordFinding(finding);

  console.log(`  ${bold(String(findings.length))} credential(s) found\n`);
  for (const finding of findings) {
    console.log(`    ${redact(finding.secret)}  ${dim(`${finding.file}:${finding.startLine}`)}`);
    console.log(dim(`      ${finding.commit.slice(0, 8)}  ${finding.author}  "${finding.commitMessage}"`));
  }

  if (findings.length === 0) {
    console.log(green("\n  Nothing to do.\n"));
    return state;
  }

  // 2 and 3. Verify and assess, both read-only, both unattended.
  console.log(heading("2/6", "Verify each credential in a sandbox"));
  console.log(dim(`  read-only templates, network restricted to the provider endpoint\n`));

  const records = await verifyAll(findings, sandbox);
  for (const record of records) {
    state.setVerification(record);
    state.audit.recordVerification(record);
    const finding = state.finding(record.findingId);
    if (!finding) continue;
    console.log(
      renderVerification(record, `${finding.file}:${finding.startLine}`, redact(finding.secret)),
    );
    console.log();
  }

  // 4. Plan
  console.log(heading("3/6", "Remediation plan"));
  const plan = buildPlan(findings, records);
  state.setPlan(plan);
  state.audit.record({
    type: "plan.built",
    at: new Date().toISOString(),
    items: plan.items,
    summary: plan.summary,
  });

  console.log(
    dim(
      `  ${plan.summary.total} findings: ${plan.summary.live} live, ` +
        `${plan.summary.dead} dead, ${plan.summary.unknown} unknown\n`,
    ),
  );
  plan.items.forEach((item, i) => {
    console.log(renderPlanItem(item, i));
    console.log();
  });

  // 5. The gate
  const gated = plan.items.filter((item) => item.requiresApproval);
  console.log(heading("4/6", "Human approval"));

  if (gated.length === 0) {
    console.log(green("  Nothing here needs a human. No destructive action is proposed.\n"));
  }

  const approved: PlanItem[] = [];
  for (const item of gated) {
    state.audit.record({
      type: "approval.requested",
      at: new Date().toISOString(),
      findingId: item.findingId,
      action: item.action,
      blastRadius: item.blastRadius,
    });
    console.log(renderApprovalGate(item));

    const decision = await askApproval(item, options);
    const finding = state.finding(item.findingId);
    if (!finding) continue;

    state.approvals.grant({
      findingId: item.findingId,
      secret: finding.secret,
      decision,
      grantedBy: options.operator,
    });
    state.audit.record({
      type: "approval.decided",
      at: new Date().toISOString(),
      findingId: item.findingId,
      decision,
      decidedBy: options.operator,
    });

    if (decision === "allow") {
      approved.push(item);
      console.log(green(bold("\n  Approved.\n")));
    } else {
      console.log(yellow(bold("\n  Denied. The credential was left alone.\n")));
    }
  }

  // 6. Act, then prove it worked
  console.log(heading("5/6", "Revoke"));
  if (approved.length === 0) {
    console.log(dim("  Nothing was approved, so nothing was revoked.\n"));
  }

  for (const item of approved) {
    const finding = state.finding(item.findingId);
    const verification = state.verification(item.findingId);
    if (!finding) continue;

    const grant = state.approvals
      .all()
      .find((g) => g.findingId === item.findingId && g.decision === "allow");

    try {
      console.log(dim(`  revoking ${item.maskedSecret} ...`));
      const record = await revokeCredential({
        finding,
        statusBefore: verification?.status ?? "UNVERIFIED",
        approvalToken: grant?.token,
        registry: state.approvals,
        sandbox,
        dryRun: options.dryRun,
      });
      state.audit.recordRevoke(record);

      if (!record.attempted) {
        console.log(dim(`  ${record.note ?? "no request sent"}`));
      } else if (record.confirmed) {
        console.log(green(bold(`  Confirmed dead.`)));
        console.log(
          dim(
            `  provider returned ${record.httpStatus}, then re-verification observed ` +
              `${record.statusBefore} to ${record.statusAfter}`,
          ),
        );
      } else {
        console.log(red(bold("  NOT confirmed.")));
        console.log(red(`  ${record.note ?? ""}`));
      }
    } catch (error) {
      // Reaching here means the gate refused, which is a result, not a crash.
      const reason = error instanceof ApprovalError ? error.message : String(error);
      state.audit.record({
        type: "action.refused",
        at: new Date().toISOString(),
        findingId: item.findingId,
        reason,
      });
      console.log(red(`  Refused: ${reason}`));
    }
    console.log();
  }

  // Audit
  console.log(heading("6/6", "Audit trail"));
  state.audit.record({
    type: "run.completed",
    at: new Date().toISOString(),
    runId: state.runId,
    durationMs: Date.now() - startedAt,
  });

  const auditPath = join(options.auditDir, `${state.runId}.jsonl`);
  await state.audit.save(auditPath);
  console.log(`  ${state.audit.events().length} events written to ${bold(auditPath)}`);
  console.log(dim("  every finding, verification, decision and action, credentials masked\n"));
  console.log(rule());

  return state;
}

async function askApproval(
  item: PlanItem,
  options: RunOptions,
): Promise<"allow" | "deny"> {
  if (options.dryRun || options.nonInteractive || process.stdin.isTTY !== true) {
    console.log(
      dim("\n  Stopped. Run without --dry-run in a terminal to make a decision.\n"),
    );
    return "deny";
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      bold(`\n  Revoke ${item.maskedSecret}? `) + dim("type 'revoke' to confirm, anything else to skip: "),
    );
    return answer.trim().toLowerCase() === "revoke" ? "allow" : "deny";
  } finally {
    rl.close();
  }
}
