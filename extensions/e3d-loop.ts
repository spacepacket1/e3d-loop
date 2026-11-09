import { randomUUID } from "node:crypto";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../src/config.ts";
import { runDoctor, formatDoctor } from "../src/doctor.ts";
import { assertDepth, formatReport, runHelper } from "../src/helper.ts";

const GUIDANCE = `
## E3D Loop (local-trusted execution: tools run on this machine without a sandbox)
- Start of a non-trivial task: if a Brain tool (mcp__futco-brain__* / mcp__*brain*) is connected, search it for the repo and task terms, read only relevant notes, cite them as note:<id>@<rev>, and report_use only for notes you actually used. Brain is advisory; propose lessons with capture (inbox), never as fact.
- For a contestable design decision, consult Pilot (e3d_quote then e3d_debate) with a self-contained question. Show the consensus AND the dissent. Pilot's answer is input, not approval. Never send private code to web-search-enabled debates.
- For an independent look at code (investigation or review), call loop_investigate. It uses a separate read-only session, possibly a different model. Its findings are claims; verify important ones yourself or by running tests. Do not call it recursively.
- Report test results only from commands you actually ran. If Brain or Pilot is unavailable, say so and continue with repository evidence.`;

export default function (pi: ExtensionAPI) {
  const taskId = process.env.E3D_LOOP_TASK_ID || "task-" + randomUUID().slice(0, 8);

  pi.on("before_agent_start", async (event) => {
    if (process.env.E3D_LOOP_NO_GUIDANCE) return;
    return { systemPrompt: event.systemPrompt + "\n" + GUIDANCE };
  });

  pi.registerTool({
    name: "loop_investigate",
    label: "Independent helper",
    description: "Ask a separate, read-only helper session (optionally a different model) to investigate or review code in a frozen snapshot of this repo. Returns claims with quote-checked evidence. Bounded by time, turns and cost.",
    parameters: Type.Object({
      question: Type.String({ description: "Self-contained question or review request. The helper sees the repo snapshot but not this conversation." }),
      role: Type.Optional(Type.Union([Type.Literal("investigator"), Type.Literal("reviewer")], { description: "Default investigator" })),
      focus_paths: Type.Optional(Type.Array(Type.String(), { description: "Files or directories to start from" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      assertDepth();
      const cfg = loadConfig();
      const fm = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
      const rec = await runHelper({ cwd: ctx.cwd, question: params.question, role: params.role ?? "investigator", focusPaths: params.focus_paths,
        config: cfg, parentTaskId: taskId, foregroundModel: fm, signal,
        onProgress: (m) => onUpdate?.({ content: [{ type: "text", text: m }], details: {} }) });
      pi.appendEntry("e3d-loop/evidence", { assignmentId: rec.assignmentId, parentTaskId: taskId, status: rec.status, model: rec.actual, snapshotDigest: rec.snapshot.digest, artifactPath: rec.artifactPath, findings: rec.findings.length });
      return { content: [{ type: "text", text: formatReport(rec) }], details: { assignmentId: rec.assignmentId, artifactPath: rec.artifactPath } };
    },
  });

  pi.registerCommand("e3d-doctor", {
    description: "Check E3D Loop setup: Pi pin, Pilot/Brain MCP, helper model, command conflicts",
    handler: async (_args, ctx) => { ctx.ui.notify(formatDoctor(await runDoctor({ cwd: ctx.cwd })), "info"); },
  });
}
