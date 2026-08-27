/**
 * Resumes a paused turn with a denial, proving the human decision is honoured and that
 * a refusal is reported rather than crashing the agent.
 *
 * Denial specifically, because approving would revoke a real credential.
 */
const BASE = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const sessionId = process.argv[2];
if (!sessionId) throw new Error("usage: node scripts/trueforge-deny.mjs <sessionId>");

async function api(path, init) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const turns = (await api(`/sessions/${sessionId}/turns`)).data ?? [];
const last = turns[turns.length - 1];
const events = (await api(`/sessions/${sessionId}/turns/${last.id}/events`)).data ?? [];

const pending = events.find((e) => e.type === "tool.approval_required");
if (!pending) throw new Error("no pending approval on the last turn");

console.log("=== the pause, as the harness recorded it ===");
console.log(JSON.stringify(pending, null, 2).slice(0, 900));

// The REST API returns snake_case; the TypeScript SDK camelCases it. Accept either
// so this works whichever surface it is pointed at.
const pendingCalls = pending.tool_calls ?? pending.toolCalls ?? [];
const threadId = pending.thread_id ?? pending.threadId;

// Look up what the agent actually asked to do, which is what a human would read.
for (const ref of pendingCalls) {
  const sourceId = ref.source_event_id ?? ref.sourceEventId;
  const source = events.find((e) => e.id === sourceId);
  const call = (source?.tool_calls ?? source?.toolCalls ?? []).find((tc) => tc.id === ref.id);
  if (call) {
    console.log("\ntool awaiting approval:", call.toolInfo?.name);
    console.log("arguments:", String(call.function?.arguments).slice(0, 300));
  }
}

const approvals = pendingCalls.map((ref) => ({
  type: "user.tool_approval",
  ...(threadId ? { thread_id: threadId } : {}),
  tool_call_id: ref.id,
  approval: { status: "deny", reason: "Staging deploy still uses this key. Rotating first." },
}));

console.log("\n=== resuming with DENY ===");
const created = await api(`/sessions/${sessionId}/turns`, {
  method: "POST",
  body: JSON.stringify({ stream: false, input: approvals }),
});

let turn = created.data ?? created;
for (let i = 0; i < 120 && turn.state?.status === "running"; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  turn = (await api(`/sessions/${sessionId}/turns/${turn.id}`)).data ?? turn;
}

console.log("status:", turn.state?.status);
console.log("\nagent said:\n" + String(turn.state?.output?.content ?? "").slice(0, 1200));
