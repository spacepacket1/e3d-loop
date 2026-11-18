import { randomUUID } from "node:crypto";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "../src/config.ts";
import { runDoctor, formatDoctor } from "../src/doctor.ts";
import { assertDepth, formatReport, runHelper } from "../src/helper.ts";
import { formatRun, planRun, runImplementation, type PhaseRecord, type RunMode } from "../src/implement.ts";
import { familyOf } from "../src/providers.ts";
import { stateDir } from "../src/config.ts";

const GUIDANCE = `
## E3D Loop (local-trusted execution: tools run on this machine without a sandbox)
- Start of a non-trivial task: if a Brain tool (mcp__futco-brain__* / mcp__*brain*) is connected, search it for the repo and task terms, read only relevant notes, cite them as note:<id>@<rev>, and report_use only for notes you actually used. Brain is advisory; propose lessons with capture (inbox), never as fact.
- For a contestable design decision, consult Pilot (e3d_quote then e3d_debate) with a self-contained question. Show the consensus AND the dissent. Pilot's answer is input, not approval. Never send private code to web-search-enabled debates.
- For an independent look at code (investigation or review), call loop_investigate. It uses a separate read-only session, possibly a different model. Its findings are claims; verify important ones yourself or by running tests. Do not call it recursively.
- To implement a multi-step change, write a phased spec ("## Phase N - Title", optional <!-- runner:model=high|default|mini -->), then call loop_implement with action "plan" and show the user which provider and model e3d-code picked per phase. Before "run", ASK the user whether to run in auto mode or one phase at a time. Each phase is run by e3d-code in an isolated git worktree, committed, checked with the user's check command, and reviewed by a different model family before the next phase. Never merge or push the result.
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

  pi.registerTool({
    name: "loop_implement",
    label: "Implement via e3d-code",
    description: "Run a phased Markdown spec through e3d-code, one phase at a time, in an isolated git worktree on a new branch. action=plan only lists the provider and model e3d-code picks for each phase. action=run executes: each phase is committed, checked with check_command, and reviewed by a different model family; it stops on the first failure. Ask the user auto vs step before action=run; Loop also asks in interactive sessions. Never merges or pushes.",
    parameters: Type.Object({
      spec_path: Type.String({ description: "Path to the phased Markdown spec (phase headings like '## Phase 1 - Title')." }),
      action: Type.Union([Type.Literal("plan"), Type.Literal("run")]),
      mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("step")], { description: "Only honored in non-interactive sessions with E3D_LOOP_ALLOW_UNATTENDED=1; interactive sessions ask the user." })),
      check_command: Type.Optional(Type.String({ description: "Shell command run in the worktree after each phase (for example 'npm test'). A non-zero exit stops the run." })),
      phases: Type.Optional(Type.Array(Type.Number(), { description: "Only these phase numbers." })),
      provider: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")], { description: "Force the e3d-code runner for phases without an explicit annotation." })),
      auto_route: Type.Optional(Type.Boolean({ description: "Let e3d-code classify each phase's complexity with one cheap model call. Default true." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      assertDepth();
      const cfg = loadConfig();
      const autoRoute = params.auto_route ?? true;
      const note = (m: string) => onUpdate?.({ content: [{ type: "text", text: m }], details: {} });
      const { phases } = await planRun({ cwd: ctx.cwd, specPath: params.spec_path, provider: params.provider, autoRoute }, cfg.implement);
      const table = phases.map((p) => `Phase ${p.phase}: ${p.provider}/${p.model} (${familyOf(p.provider)} writes, ${familyOf(cfg.implement.reviewers[familyOf(p.provider)])} reviews) - ${p.title}`).join("\n");
      if (params.action === "plan") return { content: [{ type: "text", text: `e3d-code routing (auto-route ${autoRoute ? "on" : "off"}):\n${table}\n\nNothing was run. Next: ask the user auto or step, then call again with action=run.` }], details: {} };

      let mode: RunMode;
      if (ctx.hasUI) {
        const pick = await ctx.ui.select(`E3D Loop will run ${phases.length} phase(s) through e3d-code in an isolated git worktree (no sandbox; the writer can edit files and run shell commands there):\n${table}\nHow should it run?`,
          ["One phase at a time (confirm before each)", "Auto (all phases, stop on first failure)", "Cancel"]);
        if (!pick || pick === "Cancel") return { content: [{ type: "text", text: "Cancelled by the user. Nothing was run." }], details: {} };
        mode = pick.startsWith("Auto") ? "auto" : "step";
      } else {
        if (process.env.E3D_LOOP_ALLOW_UNATTENDED !== "1" || !params.mode) throw new Error("loop_implement run needs an interactive user to choose auto or step. In non-interactive mode set E3D_LOOP_ALLOW_UNATTENDED=1 and pass mode.");
        mode = params.mode;
      }
      const res = await runImplementation({ cwd: ctx.cwd, specPath: params.spec_path, mode, phases: params.phases, checkCommand: params.check_command, provider: params.provider, autoRoute, taskId: taskId + "-" + randomUUID().slice(0, 4) }, cfg.implement, stateDir(), {
        progress: note, signal,
        confirmPhase: async (p) => ctx.hasUI ? await ctx.ui.confirm(`Run phase ${p.phase}?`, `${p.title}\nwriter: ${p.provider}/${p.model}`) : true,
        review: async ({ worktreeDir, phase, writerFamily, diff, files }) => {
          const reviewerModel = cfg.implement.reviewers[writerFamily] ?? cfg.helper.model;
          if (!reviewerModel) throw new Error(`no reviewer configured for writer family "${writerFamily}"`);
          const rec = await runHelper({ cwd: worktreeDir, role: "reviewer", config: { ...cfg, helper: { ...cfg.helper, model: reviewerModel } }, parentTaskId: taskId, signal, focusPaths: files.slice(0, 20),
            question: `Review this change (phase ${phase.phase}: ${phase.title}) written by a ${writerFamily} model. Look for correctness bugs, missing edge cases and unmet requirements in the changed files. Do not claim anything was run.\n\nDiff:\n${diff}` });
          pi.appendEntry("e3d-loop/evidence", { assignmentId: rec.assignmentId, parentTaskId: taskId, status: rec.status, model: rec.actual, snapshotDigest: rec.snapshot.digest, artifactPath: rec.artifactPath, findings: rec.findings.length, phase: phase.phase });
          if (rec.status !== "succeeded" || !rec.outputParsed) throw new Error(`reviewer ${reviewerModel} ${rec.status}${rec.blockedReason ? ": " + rec.blockedReason : ""}${rec.outputParsed ? "" : " (no structured findings)"}`);
          const blocking = rec.findings.filter((f) => f.severity === "high" && f.verified).length;
          const used = rec.actual ? `${rec.actual.provider}/${rec.actual.model}` : reviewerModel;
          return { model: used, independentOfWriter: familyOf(used) !== writerFamily, status: rec.status, findings: rec.findings.length, blocking, artifactPath: rec.artifactPath, summary: rec.summary };
        },
      });
      pi.appendEntry("e3d-loop/implement", { taskId, status: res.status, artifactPath: res.artifactPath, branch: res.worktree.branch });
      return { content: [{ type: "text", text: formatRun(res) }], details: { artifactPath: res.artifactPath, worktree: res.worktree.dir } };
    },
  });

  pi.registerCommand("e3d-doctor", {
    description: "Check E3D Loop setup: Pi pin, Pilot/Brain MCP, helper model, command conflicts",
    handler: async (_args, ctx) => { ctx.ui.notify(formatDoctor(await runDoctor({ cwd: ctx.cwd })), "info"); },
  });
}
