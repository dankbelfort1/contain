/**
 * The tools, and the annotations that gate them.
 *
 * This file is where the project's thesis becomes mechanical rather than aspirational.
 *
 * Each tool declares an MCP annotation describing what it does to the world. The
 * scanner, the verifier, the blast radius assessment and the planner are annotated
 * readOnly. Exactly one tool, revoke_credential, is annotated destructive.
 *
 * TrueForge is configured with `require_approval_for_tools: ["@destructive"]`, and
 * resolves that selector from these annotations. So the human gate is a property of
 * the tool manifest, not of our control flow. There is no `if (approved)` branch
 * anywhere that someone could delete, and adding a new dangerous tool gates it
 * automatically as long as it is annotated honestly.
 *
 * The agent therefore earns information freely and cannot earn permission at all.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPlan } from "../agent/plan.js";
import { ApprovalError } from "../policy/approval.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import { scanRepository } from "../tools/scanner.js";
import { revokeCredential, type RevokePoster } from "../tools/revoke.js";
import { verifyFinding } from "../tools/verify.js";
import { RunState, toSafeFinding } from "./state.js";

export interface ToolDeps {
  state: RunState;
  sandbox: SandboxExecutor;
  /** Who approvals are attributed to in the audit trail. */
  operator: string;
  dryRun: boolean;
  /**
   * Whether this server sits behind a harness that gates destructive tools itself.
   *
   * Off by default, and it has to stay that way. When it is off, revoke_credential
   * requires an approval token bound to the credential, which is the only protection
   * a standalone server has: the HTTP endpoint does not enforce the destructive
   * annotation, so anything that can reach loopback could otherwise revoke a
   * discovered credential with no human involved.
   *
   * Turn it on only when a harness like TrueForge is configured to require approval
   * for destructive tools, because then reaching this handler already means a human
   * allowed the call. Switching it on without that is removing the gate.
   */
  harnessGatesDestructiveTools?: boolean | undefined;
  /** Injectable for tests, so the destructive path can be exercised without firing. */
  post?: RevokePoster | undefined;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown>;
}

/** Read-only: observes, changes nothing, safe to run without asking anyone. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Read-only but reaches an external provider. */
const READ_ONLY_REMOTE: ToolAnnotations = { ...READ_ONLY, openWorldHint: true };

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "scan_repository",
    title: "Scan a repository for leaked credentials",
    description:
      "Runs gitleaks over a repository's full git history, not just its working tree, and " +
      "returns the credentials it finds with the secret values masked. Most real leaks were " +
      "committed once and deleted later, so they are invisible in current code.",
    annotations: READ_ONLY,
    inputSchema: { repositoryPath: z.string().describe("Path to the git repository to scan.") },
    async handler(args, deps) {
      const repositoryPath = String(args["repositoryPath"]);
      const findings = await scanRepository(repositoryPath);
      deps.state.setFindings(repositoryPath, findings);

      deps.state.audit.record({
        type: "run.started",
        at: new Date().toISOString(),
        runId: deps.state.runId,
        repository: repositoryPath,
        dryRun: deps.dryRun,
      });
      deps.state.audit.record({
        type: "scan.completed",
        at: new Date().toISOString(),
        scanner: "gitleaks",
        findingCount: findings.length,
      });
      for (const finding of findings) deps.state.audit.recordFinding(finding);

      return { findingCount: findings.length, findings: findings.map(toSafeFinding) };
    },
  },
  {
    name: "verify_credential",
    title: "Check whether a credential still works",
    description:
      "Runs a vetted, read-only verification template inside a sandbox whose network is " +
      "restricted to the provider's endpoint. Returns LIVE, DEAD, or UNKNOWN, plus what the " +
      "credential can reach if it is live. Never modifies anything at the provider.",
    annotations: READ_ONLY_REMOTE,
    inputSchema: { findingId: z.string().describe("Finding id from scan_repository.") },
    async handler(args, deps) {
      const findingId = String(args["findingId"]);
      const finding = deps.state.finding(findingId);
      if (!finding) throw new Error(`Unknown finding: ${findingId}`);

      const record = await verifyFinding(finding, deps.sandbox);
      deps.state.setVerification(record);
      deps.state.audit.recordVerification(record);

      return {
        findingId: record.findingId,
        status: record.status,
        principal: record.principal ?? null,
        capabilities: record.capabilities,
        blastRadius: record.blastRadius,
        templateId: record.templateId,
        sandboxKind: record.sandboxKind,
        reason: record.reason ?? null,
      };
    },
  },
  {
    name: "build_remediation_plan",
    title: "Produce the remediation plan",
    description:
      "Turns the findings and their verification results into an ordered plan, worst first, " +
      "with a stated reason for every item. Marks which items cannot proceed without human " +
      "approval. Produces the plan only; it does not carry any of it out.",
    annotations: READ_ONLY,
    inputSchema: {},
    async handler(_args, deps) {
      const plan = buildPlan(deps.state.findings(), deps.state.verifications());
      deps.state.setPlan(plan);
      deps.state.audit.record({
        type: "plan.built",
        at: new Date().toISOString(),
        items: plan.items,
        summary: plan.summary,
      });
      return plan;
    },
  },
  {
    name: "read_audit_trail",
    title: "Read the audit trail for this run",
    description:
      "Returns every recorded event in order: what was found, how it was verified, what was " +
      "planned, who approved what, and what was done. Credentials are masked throughout.",
    annotations: READ_ONLY,
    inputSchema: {},
    async handler(_args, deps) {
      return { runId: deps.state.runId, events: deps.state.audit.events() };
    },
  },
  {
    name: "revoke_credential",
    title: "Permanently revoke a leaked credential",
    description:
      "Destroys a credential at the provider. This cannot be undone and may break anything " +
      "currently using it. Requires an approval that a human granted for this specific " +
      "credential. After revoking, re-runs verification to confirm the credential actually " +
      "stopped working rather than trusting the provider's response.",
    // The one destructive tool. TrueForge resolves "@destructive" from this and stops
    // the turn here for a human decision.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      // Safe to retry: a spent approval returns the first result instead of firing again.
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      findingId: z.string().describe("Finding id of the credential to revoke."),
      approvalToken: z
        .string()
        .optional()
        .describe(
          "Approval token, when this server is driven by something that issues them. " +
            "Omit it under a harness that gates destructive tools itself.",
        ),
    },
    async handler(args, deps) {
      const findingId = String(args["findingId"]);
      const finding = deps.state.finding(findingId);
      if (!finding) throw new Error(`Unknown finding: ${findingId}`);

      const verification = deps.state.verification(findingId);

      // Two callers, two gates, and they are not interchangeable.
      //
      // The CLI and the UI issue an approval bound to this credential and pass the
      // token. That binding is what stops one approval being used on a different key.
      //
      // A harness that gates destructive tools reaches this handler only after its own
      // human approval, and nothing on that path issues our token. But the HTTP
      // endpoint cannot tell a gating harness from any other local caller, so a
      // missing token is only treated as harness approval when the operator has said
      // that is the deployment. Otherwise it is refused, because inferring approval
      // from its absence is not a gate.
      const suppliedToken = args["approvalToken"];
      const hasToken = typeof suppliedToken === "string" && suppliedToken.length > 0;

      if (!hasToken && deps.harnessGatesDestructiveTools !== true) {
        const message =
          "Human approval required. This action may affect production. " +
          "No approval token was supplied, and this server is not configured to sit " +
          "behind a harness that gates destructive tools.";
        deps.state.audit.record({
          type: "action.refused",
          at: new Date().toISOString(),
          findingId,
          reason: message,
        });
        throw new ApprovalError(message);
      }

      const approvalToken = hasToken
        ? suppliedToken
        : deps.state.approvals.grant({
            findingId,
            secret: finding.secret,
            decision: "allow",
            grantedBy: `${deps.operator} (via harness tool approval)`,
          }).token;

      try {
        const record = await revokeCredential({
          finding,
          statusBefore: verification?.status ?? "UNVERIFIED",
          approvalToken,
          registry: deps.state.approvals,
          sandbox: deps.sandbox,
          dryRun: deps.dryRun,
          ...(deps.post ? { post: deps.post } : {}),
        });
        deps.state.audit.recordRevoke(record);
        return record;
      } catch (error) {
        // A refusal is part of the record. The trail should show that the agent
        // reached for the destructive tool and was stopped.
        if (error instanceof ApprovalError) {
          deps.state.audit.record({
            type: "action.refused",
            at: new Date().toISOString(),
            findingId,
            reason: error.message,
          });
        }
        throw error;
      }
    },
  },
];

/** Tools the agent may run freely, because they cannot change anything. */
export function readOnlyToolNames(): string[] {
  return TOOLS.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name);
}

/** Tools that must stop for a human. */
export function destructiveToolNames(): string[] {
  return TOOLS.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name);
}
