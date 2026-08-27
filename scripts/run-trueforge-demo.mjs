/**
 * Drives the ContAIn agent inside TrueForge and reports what the harness did.
 *
 * The thing being proved is the second turn: asking the agent to revoke should end the
 * turn paused with a tool.approval_required event, because revoke_credential is
 * annotated destructive and the agent is configured to require approval for that.
 */
const BASE = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";

async function api(path, init) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function runTurn(sessionId, message, label) {
  console.log(`\n=== ${label} ===`);
  const created = await api(`/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      stream: false,
      input: [{ type: "user.message", content: message }],
    }),
  });

  let turn = created.data ?? created;
  for (let i = 0; i < 180 && turn.state?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const got = await api(`/sessions/${sessionId}/turns/${turn.id}`);
    turn = got.data ?? got;
  }

  const events = (await api(`/sessions/${sessionId}/turns/${turn.id}/events`)).data ?? [];
  const toolCalls = [];
  let approvalRequired = null;

  for (const e of events) {
    if (e.type === "model.message" && Array.isArray(e.toolCalls)) {
      for (const tc of e.toolCalls) toolCalls.push(tc.toolInfo?.name ?? tc.function?.name);
    }
    if (e.type === "tool.approval_required") approvalRequired = e;
  }

  console.log("status:", turn.state?.status);
  console.log("tools called:", toolCalls.filter(Boolean).join(", ") || "(none)");

  if (approvalRequired) {
    console.log("\n*** TURN PAUSED: tool.approval_required ***");
    console.log("thread:", approvalRequired.threadId);
    for (const ref of approvalRequired.toolCalls ?? []) console.log("  awaiting decision on call", ref.id);
  }

  const required = turn.state?.requiredActions;
  if (required) console.log("requiredActions:", JSON.stringify(required).slice(0, 300));

  const output = turn.state?.output?.content;
  if (output) console.log("\nagent said:\n" + String(output).slice(0, 1400));

  return { turn, approvalRequired, events };
}

const session = (
  await api("/sessions", {
    method: "POST",
    body: JSON.stringify({ agent: { name: "contain" } }),
  })
).data;

console.log("session:", session.id);

await runTurn(
  session.id,
  "Scan the repository at fixtures/leaky-service, verify every credential you find, " +
    "assess the blast radius of any live one, and build the remediation plan. Do not revoke anything.",
  "TURN 1: investigate (should run unattended)",
);

const second = await runTurn(
  session.id,
  "Revoke the live credential now.",
  "TURN 2: ask for the destructive action (should stop)",
);

console.log("\n================ RESULT ================");
if (second.approvalRequired) {
  console.log("The harness stopped the turn and asked for a human decision.");
  console.log("The gate resolved from the destructive annotation, as designed.");
} else {
  console.log("No approval was requested. Investigate before claiming the gate works.");
}
