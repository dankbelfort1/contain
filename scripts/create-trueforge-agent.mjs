/**
 * Creates the ContAIn agent in a running TrueForge instance.
 *
 * Done over the API rather than the UI because `require_approval_for_tools` is API-only,
 * and that field is the entire point: it is what turns our destructive annotation into a
 * human approval prompt. An agent built in the UI would have no gate.
 */
const BASE = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";

const INSTRUCTIONS = `You investigate leaked credentials in a git repository and propose
how to clean them up.

Work through this loop, in order:

1. Scan the repository with scan_repository. It reads full git history, so expect
   findings in files that no longer exist.
2. Verify every finding with verify_credential, one at a time. This runs a vetted
   read-only probe in a sandbox. Never skip verification and never assume a credential
   is dead because it looks old or fake.
3. For anything LIVE, read the blast radius carefully. State in plain words what the
   credential can reach. This is the most useful thing you produce: the person
   deciding whether to revoke needs to understand the consequence before they choose.
4. Build the plan with build_remediation_plan.
5. Stop.

About stopping: revoke_credential is destructive and irreversible, and you cannot call
it without a human approving it. This is deliberate and it is not an obstacle to work
around. Present the plan, say plainly which items need a decision and why, and wait.

Some things worth being careful about:

- UNKNOWN is a real answer. If verification could not establish whether a credential
  works, say so. Do not guess. A wrong DEAD leaves a working credential in place.
- Never print a credential value. You will only ever be given masked values.
- A credential that was committed and later deleted is still exposed. Deleting the file
  again does not help, and anyone reading your summary needs to know that.
- After a revoke, report what the re-verification actually observed, not what the
  provider's response implied.`;

const manifest = {
  model: { name: "google-gemini/gemini-2.5-flash" },
  instructions: INSTRUCTIONS,
  mcp_servers: [
    {
      name: "contain",
      enable_tools: ["@all"],
      // The whole design in one line. Resolved from the MCP tool annotations.
      require_approval_for_tools: ["@destructive"],
      preload: true,
    },
  ],
  config: {
    // Our verification runs its own sandbox inside the MCP tool, so the harness does
    // not need to provision one.
    sandbox: { enabled: false },
    generative_ui: { enabled: true },
    ask_user_questions: { enabled: true },
    iteration_limit: 40,
  },
};

const res = await fetch(`${BASE}/api/v1/agents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "contain", manifest }),
});

const text = await res.text();
console.log("http", res.status);
console.log(text.slice(0, 600));
