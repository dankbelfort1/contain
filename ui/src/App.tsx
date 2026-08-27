/**
 * The workflow view.
 *
 * Laid out so the loop reads top to bottom in the order it happens, and so the one
 * step that needs a person is unmistakably different from the five that do not.
 * Everything above the gate is investigation the agent did unattended; the gate is
 * where it stopped.
 */
import { useCallback, useEffect, useState } from "react";

type Status = "LIVE" | "DEAD" | "UNKNOWN" | "UNVERIFIED";
type Severity = "critical" | "high" | "medium" | "low";

interface Capability {
  scope: string;
  severity: Severity;
  plain: string;
}
interface BlastRadius {
  headline: string;
  capabilities: Capability[];
  reach: string[];
  worstSeverity: Severity;
}
interface SafeFinding {
  findingId: string;
  provider: string;
  maskedSecret: string;
  file: string;
  startLine: number;
  commit: string;
  author: string;
  commitMessage: string;
}
interface Verification {
  findingId: string;
  status: Status;
  principal?: string;
  templateId: string | null;
  sandboxKind: string | null;
  elapsedMs: number;
  capabilities: string[];
  blastRadius: BlastRadius;
  reason?: string;
}
interface PlanItem {
  findingId: string;
  maskedSecret: string;
  location: string;
  status: Status;
  action: string;
  reason: string;
  blastRadius: string;
  requiresApproval: boolean;
  severity: Severity;
}
interface Snapshot {
  runId: string;
  stage: string;
  repository: string;
  dryRun: boolean;
  findings: SafeFinding[];
  verifications: Verification[];
  plan: { items: PlanItem[]; summary: Record<string, number> } | null;
  approvals: { findingId: string; decision: string; grantedBy: string }[];
  audit: { type: string; at: string; [k: string]: unknown }[];
}

const STEPS = [
  { key: "scan", label: "Scan" },
  { key: "verify", label: "Verify" },
  { key: "assess", label: "Blast radius" },
  { key: "plan", label: "Plan" },
  { key: "gate", label: "Human approval", gate: true },
  { key: "revoke", label: "Revoke + audit" },
];

async function post(path: string): Promise<Snapshot> {
  const res = await fetch(path, { method: "POST" });
  return (await res.json()) as Snapshot;
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/state");
    setSnap((await res.json()) as Snapshot);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<Snapshot>) => {
    setBusy(label);
    setError(null);
    try {
      setSnap(await fn());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (findingId: string, decision: "allow" | "deny") => {
    setBusy(decision);
    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ findingId, decision }),
      });
      setSnap((await res.json()) as Snapshot);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (findingId: string) => {
    setBusy("revoke");
    setError(null);
    try {
      const res = await fetch("/api/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ findingId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error as string);
        if (body.state) setSnap(body.state as Snapshot);
      } else {
        setSnap(body as Snapshot);
      }
    } finally {
      setBusy(null);
    }
  };

  if (!snap) return <div className="wrap">Loading…</div>;

  const stageIndex = ["idle", "scanned", "verified", "verified", "planned", "awaiting_approval", "done"];
  const reached = (key: string) => {
    const order = ["scan", "verify", "assess", "plan", "gate", "revoke"];
    const at = {
      idle: -1,
      scanned: 0,
      verified: 2,
      planned: 3,
      awaiting_approval: 4,
      done: 5,
    }[snap.stage] ?? -1;
    return order.indexOf(key) <= at;
  };
  const current = (key: string) => {
    const order = ["scan", "verify", "assess", "plan", "gate", "revoke"];
    const at = {
      idle: 0,
      scanned: 1,
      verified: 3,
      planned: 4,
      awaiting_approval: 4,
      done: 5,
    }[snap.stage] ?? 0;
    return order.indexOf(key) === at;
  };

  const gated = snap.plan?.items.filter((i) => i.requiresApproval) ?? [];
  const decidedFor = (id: string) => snap.approvals.find((a) => a.findingId === id);
  const revoked = snap.audit.filter((e) => e.type === "revoke.completed");

  return (
    <div className="wrap">
      <header>
        <h1>
          Cont<span className="ai">AI</span>n
        </h1>
        <p className="thesis">
          The agent earns information, not permissions. It investigates progressively, but
          destructive authority stays behind a human trust boundary.
        </p>
        <div className="meta">
          repository <code>{snap.repository}</code> · run <code>{snap.runId}</code>
          {snap.dryRun ? " · DRY RUN, nothing will be revoked" : ""}
        </div>
      </header>

      <div className="rail">
        {STEPS.map((s) => (
          <div
            key={s.key}
            className={[
              "step",
              s.gate ? "gate" : "",
              current(s.key) ? "active" : "",
              reached(s.key) && !current(s.key) ? "done" : "",
            ].join(" ")}
          >
            <span className="n">{s.gate ? "STOPS HERE" : "AUTOMATIC"}</span>
            {s.label}
          </div>
        ))}
      </div>

      <div className="controls">
        <button className="primary" disabled={busy !== null} onClick={() => void act("scan", () => post("/api/scan"))}>
          1. Scan repository
        </button>
        <button
          disabled={busy !== null || snap.findings.length === 0}
          onClick={() => void act("verify", () => post("/api/verify"))}
        >
          2. Verify in sandbox
        </button>
        <button
          disabled={busy !== null || snap.verifications.length === 0}
          onClick={() => void act("plan", () => post("/api/plan"))}
        >
          3. Build plan
        </button>
        <div className="spacer" />
        <button disabled={busy !== null} onClick={() => void act("reset", () => post("/api/reset"))}>
          Reset
        </button>
      </div>

      {busy && <p className="muted">Working: {busy}…</p>}
      {error && <p className="err">{error}</p>}

      {snap.findings.length > 0 && (
        <section>
          <h2>Findings · full git history</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Credential</th>
                  <th>Location</th>
                  <th>Introduced</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {snap.findings.map((f) => {
                  const v = snap.verifications.find((x) => x.findingId === f.findingId);
                  return (
                    <tr key={f.findingId}>
                      <td className="secret">{f.maskedSecret}</td>
                      <td>
                        {f.file}:{f.startLine}
                      </td>
                      <td className="muted">
                        {f.commit.slice(0, 8)} · {f.author}
                        <br />"{f.commitMessage}"
                      </td>
                      <td>
                        <span className={`badge ${v?.status ?? "UNVERIFIED"}`}>
                          {v?.status ?? "UNVERIFIED"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {snap.verifications.some((v) => v.status === "LIVE") && (
        <section>
          <h2>Blast radius · what the live credential can reach</h2>
          {snap.verifications
            .filter((v) => v.status === "LIVE")
            .map((v) => (
              <div className="card" key={v.findingId}>
                <div className="row">
                  <span className="badge LIVE">LIVE</span>
                  <strong>{v.principal}</strong>
                  <span className="spacer" />
                  <span className="muted">
                    {v.templateId} · sandbox {v.sandboxKind} · {v.elapsedMs}ms
                  </span>
                </div>
                <div className="blast">
                  <p>{v.blastRadius.headline}</p>
                  <ul className="caps">
                    {v.blastRadius.capabilities.slice(0, 8).map((c) => (
                      <li key={c.scope}>
                        <span className={`sev ${c.severity}`}>{c.severity.toUpperCase()}</span>
                        <span>{c.plain}</span>
                      </li>
                    ))}
                  </ul>
                  {v.blastRadius.reach.length > 0 && (
                    <p className="note">Reaches: {v.blastRadius.reach.join("; ")}</p>
                  )}
                </div>
              </div>
            ))}
        </section>
      )}

      {snap.plan && (
        <section>
          <h2>Remediation plan</h2>
          {snap.plan.items.map((item) => (
            <div className="card" key={item.findingId}>
              <div className="row">
                <span className={`badge ${item.status}`}>{item.status}</span>
                <code>{item.location}</code>
                <span className="spacer" />
                <strong>{item.action}</strong>
              </div>
              <p className="muted">{item.reason}</p>
            </div>
          ))}
        </section>
      )}

      {gated.length > 0 && (
        <section>
          <h2>The trust boundary</h2>
          {gated.map((item) => {
            const decision = decidedFor(item.findingId);
            const done = revoked.find((r) => r["findingId"] === item.findingId);

            return (
              <div className="gate" key={item.findingId}>
                <h3>HUMAN APPROVAL REQUIRED</h3>
                <p className="sub">This action may affect production.</p>
                <dl>
                  <dt>credential</dt>
                  <dd className="secret">{item.maskedSecret}</dd>
                  <dt>found at</dt>
                  <dd>{item.location}</dd>
                  <dt>proposed</dt>
                  <dd>{item.action}</dd>
                  <dt>blast radius</dt>
                  <dd>{item.blastRadius}</dd>
                </dl>
                <p className="warn">
                  Revoking is permanent. GitHub cannot restore a revoked credential.
                </p>

                {!decision && (
                  <div className="row">
                    <button
                      className="danger"
                      disabled={busy !== null}
                      onClick={() => void decide(item.findingId, "allow")}
                    >
                      Approve revocation
                    </button>
                    <button disabled={busy !== null} onClick={() => void decide(item.findingId, "deny")}>
                      Deny
                    </button>
                    <span className="muted">
                      The revoke tool cannot run until one of these is pressed.
                    </span>
                  </div>
                )}

                {decision?.decision === "allow" && !done && (
                  <div className="row">
                    <button className="danger" disabled={busy !== null} onClick={() => void revoke(item.findingId)}>
                      Revoke now
                    </button>
                    <span className="muted">Approved by {decision.grantedBy}.</span>
                  </div>
                )}

                {decision?.decision === "deny" && (
                  <p className="note">Denied. The credential was left alone and this was recorded.</p>
                )}

                {done && (
                  <div className={`result ${done["confirmed"] ? "" : "bad"}`}>
                    {done["confirmed"] ? (
                      <>
                        <strong>Confirmed dead.</strong> Provider returned{" "}
                        {String(done["httpStatus"])}, then re-verification observed{" "}
                        {String(done["statusBefore"])} to {String(done["statusAfter"])}.
                      </>
                    ) : (
                      <>
                        <strong>Not confirmed.</strong> {String(done["note"] ?? "")}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {snap.audit.length > 0 && (
        <section>
          <h2>Audit trail · {snap.audit.length} events</h2>
          <div className="card trail">
            {snap.audit.map((e, i) => (
              <div key={i}>
                <span className="muted">{String(e.at).slice(11, 19)}</span>{" "}
                <span className="t">{e.type}</span>{" "}
                <span className="muted">
                  {String(e["findingId"] ?? e["decision"] ?? e["findingCount"] ?? "")}
                </span>
              </div>
            ))}
          </div>
          <p className="note">Credentials are masked in every event.</p>
        </section>
      )}
    </div>
  );
}
