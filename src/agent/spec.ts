/**
 * The TrueForge agent.
 *
 * The important line is `require_approval_for_tools: ["@destructive"]`. TrueForge
 * resolves that selector from the annotations our MCP server publishes, so the gate is
 * declared once, here, and applies to any tool honestly annotated destructive -
 * including tools added later that nobody remembered to gate.
 *
 * The instructions below do not enforce the boundary. They explain it, so the agent
 * behaves sensibly around a wall it cannot pass rather than repeatedly walking into it.
 * If the model ignored every word of this, the boundary would still hold.
 */

export interface AgentSpec {
  model: { name: string; params?: Record<string, unknown> };
  instructions: string;
  mcp_servers: {
    name: string;
    enable_tools?: string[];
    require_approval_for_tools?: string[];
    preload?: boolean;
  }[];
  config: Record<string, unknown>;
}

export const AGENT_NAME = "contain";

export const INSTRUCTIONS = `You investigate leaked credentials in a git repository and
propose how to clean them up.

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
it without an approval a human granted for that specific credential. This is deliberate
and it is not an obstacle to work around. Present the plan, say plainly which items need
a decision and why, and wait.

Some things worth being careful about:

- UNKNOWN is a real answer. If verification could not establish whether a credential
  works, say so. Do not guess. A wrong DEAD leaves a working credential in place.
- Never print a credential value. You will only ever be given masked values; do not try
  to reconstruct or reveal them.
- A credential that was committed and later deleted is still exposed. Deleting the file
  again does not help, and anyone reading your summary needs to know that.
- After a revoke, report what the re-verification actually observed, not what the
  provider's response implied. The provider accepts the request whether or not the
  credential existed.`;

export const CONTAIN_AGENT_SPEC: AgentSpec = {
  // Gemini's free tier covers this comfortably and handles tool calling well.
  model: { name: "google-gemini/gemini-2.5-flash", params: { temperature: 0 } },
  instructions: INSTRUCTIONS,
  mcp_servers: [
    {
      name: "contain",
      enable_tools: ["@all"],
      // The whole design in one line. Resolved from the MCP tool annotations, not
      // from a list of names someone has to remember to update.
      require_approval_for_tools: ["@destructive"],
      // Preloaded because there are only five tools and the agent should know the
      // shape of the loop from the start.
      preload: true,
    },
  ],
  config: {
    sandbox: { enabled: true },
    generative_ui: { enabled: true },
    ask_user_questions: { enabled: true },
    // Deterministic output matters more than exploration here.
    iteration_limit: 40,
  },
};
