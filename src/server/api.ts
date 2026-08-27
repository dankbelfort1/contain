/**
 * HTTP API behind the workflow UI.
 *
 * The UI is a view onto a run, not a second implementation of it. Every endpoint here
 * calls the same functions the CLI calls, and the approval endpoint issues a grant
 * through the same registry the revoke tool validates against. A gate that existed
 * only in the browser would be decoration; this one is the same gate.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { buildPlan } from "../agent/plan.js";
import { ApprovalError } from "../policy/approval.js";
import { LocalSandbox } from "../sandbox/local.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import { RunState, toSafeFinding } from "../mcp/state.js";
import { scanRepository } from "../tools/scanner.js";
import { revokeCredential } from "../tools/revoke.js";
import { verifyAll } from "../tools/verify.js";

export type Stage = "idle" | "scanned" | "verified" | "planned" | "awaiting_approval" | "done";

export interface ServerOptions {
  repositoryPath: string;
  dryRun: boolean;
  operator: string;
  sandbox?: SandboxExecutor;
  /** Directory holding the built UI, when there is one. */
  staticDir?: string | undefined;
}

interface Session {
  state: RunState;
  stage: Stage;
  /** Approval tokens issued through the UI, by finding id. */
  grants: Map<string, string>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function createApiServer(options: ServerOptions): Server {
  const sandbox = options.sandbox ?? new LocalSandbox();
  let session: Session = { state: new RunState(), stage: "idle", grants: new Map() };

  function snapshot() {
    const plan = session.state.plan();
    return {
      runId: session.state.runId,
      stage: session.stage,
      repository: options.repositoryPath,
      dryRun: options.dryRun,
      findings: session.state.findings().map(toSafeFinding),
      verifications: session.state.verifications(),
      plan: plan ?? null,
      approvals: session.state.approvals.all().map((g) => ({
        findingId: g.findingId,
        decision: g.decision,
        grantedBy: g.grantedBy,
        grantedAt: g.grantedAt,
      })),
      audit: session.state.audit.events(),
    };
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    void (async () => {
      if (url.pathname === "/api/state") return json(200, snapshot());

      if (url.pathname === "/api/reset" && req.method === "POST") {
        session = { state: new RunState(), stage: "idle", grants: new Map() };
        return json(200, snapshot());
      }

      if (url.pathname === "/api/scan" && req.method === "POST") {
        const findings = await scanRepository(options.repositoryPath);
        session.state.setFindings(options.repositoryPath, findings);
        session.state.audit.record({
          type: "run.started",
          at: new Date().toISOString(),
          runId: session.state.runId,
          repository: options.repositoryPath,
          dryRun: options.dryRun,
        });
        session.state.audit.record({
          type: "scan.completed",
          at: new Date().toISOString(),
          scanner: "gitleaks",
          findingCount: findings.length,
        });
        for (const f of findings) session.state.audit.recordFinding(f);
        session.stage = "scanned";
        return json(200, snapshot());
      }

      if (url.pathname === "/api/verify" && req.method === "POST") {
        const records = await verifyAll(session.state.findings(), sandbox);
        for (const record of records) {
          session.state.setVerification(record);
          session.state.audit.recordVerification(record);
        }
        session.stage = "verified";
        return json(200, snapshot());
      }

      if (url.pathname === "/api/plan" && req.method === "POST") {
        const plan = buildPlan(session.state.findings(), session.state.verifications());
        session.state.setPlan(plan);
        session.state.audit.record({
          type: "plan.built",
          at: new Date().toISOString(),
          items: plan.items,
          summary: plan.summary,
        });
        for (const item of plan.items.filter((i) => i.requiresApproval)) {
          session.state.audit.record({
            type: "approval.requested",
            at: new Date().toISOString(),
            findingId: item.findingId,
            action: item.action,
            blastRadius: item.blastRadius,
          });
        }
        session.stage = plan.summary.awaitingApproval > 0 ? "awaiting_approval" : "planned";
        return json(200, snapshot());
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        const body = (await readBody(req)) as { findingId?: string; decision?: string };
        const finding = session.state.finding(String(body.findingId));
        if (!finding) return json(404, { error: "unknown finding" });

        // An approval is only meaningful if the person giving it saw what they were
        // approving. Without this, a caller could scan, approve and revoke while
        // skipping verification, the blast radius, and the plan entirely, which are
        // the whole reason the decision is asked of a human rather than taken
        // automatically.
        const plan = session.state.plan();
        if (!plan) {
          return json(409, {
            error:
              "No plan has been built. Verify the findings and build the plan before approving, " +
              "so the decision is made with the blast radius in view.",
          });
        }

        const item = plan.items.find((i) => i.findingId === finding.id);
        if (!item) {
          return json(409, { error: "That finding is not in the current plan." });
        }
        if (!item.requiresApproval) {
          return json(409, {
            error: `The plan does not propose a destructive action for this finding (${item.action}), so there is nothing to approve.`,
          });
        }

        // Anything other than an explicit allow or deny is a bad request, not a
        // denial. Quietly recording a malformed call as a human decision would put
        // something in the audit trail that nobody actually said.
        if (body.decision !== "allow" && body.decision !== "deny") {
          return json(400, { error: 'decision must be "allow" or "deny"' });
        }
        const decision = body.decision;
        const grant = session.state.approvals.grant({
          findingId: finding.id,
          secret: finding.secret,
          decision,
          grantedBy: options.operator,
        });
        session.grants.set(finding.id, grant.token);
        session.state.audit.record({
          type: "approval.decided",
          at: new Date().toISOString(),
          findingId: finding.id,
          decision,
          decidedBy: options.operator,
        });
        return json(200, snapshot());
      }

      if (url.pathname === "/api/revoke" && req.method === "POST") {
        const body = (await readBody(req)) as { findingId?: string };
        const finding = session.state.finding(String(body.findingId));
        if (!finding) return json(404, { error: "unknown finding" });

        try {
          const record = await revokeCredential({
            finding,
            statusBefore: session.state.verification(finding.id)?.status ?? "UNVERIFIED",
            // Deliberately read from the registry rather than taken from the request.
            // A token supplied by the browser would make the gate client-side.
            approvalToken: session.grants.get(finding.id),
            registry: session.state.approvals,
            sandbox,
            dryRun: options.dryRun,
          });
          session.state.audit.recordRevoke(record);
          session.stage = "done";
          return json(200, snapshot());
        } catch (error) {
          const refused = error instanceof ApprovalError;
          const reason = refused ? error.message : String(error);
          session.state.audit.record({
            type: refused ? "action.refused" : "action.failed",
            at: new Date().toISOString(),
            findingId: finding.id,
            reason,
          });
          return json(403, { error: reason, state: snapshot() });
        }
      }

      if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });

      await serveStatic(url.pathname, options.staticDir, res);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function serveStatic(
  pathname: string,
  staticDir: string | undefined,
  res: import("node:http").ServerResponse,
): Promise<void> {
  if (!staticDir) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("UI not built. Run: npm run ui:build");
    return;
  }

  const root = resolve(staticDir);
  // Single-page app: unknown paths fall back to index.html rather than 404.
  const requested = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(join(root, requested));
  const file = candidate.startsWith(root) ? candidate : join(root, "index.html");

  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    const fallback = await readFile(join(root, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"] as string });
    res.end(fallback);
  }
}
