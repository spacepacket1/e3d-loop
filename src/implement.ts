import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, isAbsolute, relative } from "node:path";
import { familyOf } from "./providers.ts";
import { repoKey, saveArtifact } from "./evidence.ts";

/** One phase as reported by `e3d-code <spec> --list`: the provider and model e3d-code itself would use. */
export interface PlannedPhase { phase: number; provider: string; model: string; title: string; }

export function parseList(out: string): PlannedPhase[] {
  const rows: PlannedPhase[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^Phase\s+(\d+)\t([^\t]*)\t([^\t]*)\t(.*)$/);
    if (m) rows.push({ phase: Number(m[1]), provider: m[2].trim(), model: m[3].trim(), title: m[4].trim() });
  }
  return rows;
}

export interface Proc { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; }

/** Run a command with a wall-clock limit, capturing bounded output. Never throws for a non-zero exit. */
export function run(cmd: string, args: string[], opts: { cwd: string; timeoutSec: number; env?: NodeJS.ProcessEnv; maxBytes?: number }): Promise<Proc> {
  return new Promise((resolveP) => {
    const max = opts.maxBytes ?? 200_000; let stdout = "", stderr = "", timedOut = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killAll = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; killAll(); }, opts.timeoutSec * 1000);
    child.stdout.on("data", (d) => { if (stdout.length < max) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < max) stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolveP({ code: 127, signal: null, stdout, stderr: stderr + String(e), timedOut }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolveP({ code, signal, stdout, stderr, timedOut }); });
  });
}

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export interface Worktree { dir: string; branch: string; baseRevision: string; repoRoot: string; }

/** Isolated checkout on a new branch. The user's working tree is never touched, and uncommitted edits there are NOT in it. */
export function createWorktree(cwd: string, stateDir: string, id: string): Worktree {
  const repoRoot = git(cwd, "rev-parse", "--show-toplevel").trim();
  const baseRevision = git(cwd, "rev-parse", "HEAD").trim();
  const dir = join(stateDir, "worktrees", `${repoKey(repoRoot)}-${id}`);
  mkdirSync(join(stateDir, "worktrees"), { recursive: true, mode: 0o700 });
  const branch = `loop/${id}`;
  git(repoRoot, "worktree", "add", "-q", "-b", branch, dir, baseRevision);
  return { dir, branch, baseRevision, repoRoot };
}

/** Copy the spec into the worktree (it may be uncommitted) and return its path there. */
export function stageSpec(worktree: Worktree, specPath: string, cwd: string): string {
  const abs0 = isAbsolute(specPath) ? specPath : resolve(cwd, specPath);
  if (!existsSync(abs0)) throw new Error(`spec not found: ${specPath}`);
  const abs = realpathSync(abs0); // git reports the real path (macOS /var -> /private/var), so compare real paths
  const rel = relative(realpathSync(worktree.repoRoot), abs);
  const name = rel.startsWith("..") || isAbsolute(rel) ? ".loop-spec-" + abs.split("/").pop() : rel;
  const dst = join(worktree.dir, name);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(abs, dst);
  return name;
}

export interface ManifestRow { timestamp: string; spec: string; phase: number; title: string; provider: string; model: string; mode: string; dryRun: string; exitStatus: string; }

/** The runner's own record of what it actually ran (not Loop's expectation). */
export function readManifest(dir: string, phase: number): ManifestRow | null {
  for (const sd of [".e3d-code", ".spec2code"]) {
    const f = join(dir, sd, "manifest.tsv"); if (!existsSync(f)) continue;
    const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"))
      .filter((c) => c.length >= 9 && Number(c[2]) === phase && !/^(1|true|yes)$/i.test(c[7]));
    const c = rows[rows.length - 1];
    if (c) return { timestamp: c[0], spec: c[1], phase: Number(c[2]), title: c[3], provider: c[4], model: c[5], mode: c[6], dryRun: c[7], exitStatus: c[8] };
  }
  return null;
}

export type PhaseStatus = "passed" | "runner_failed" | "no_changes" | "check_failed" | "review_blocked" | "review_unavailable" | "skipped";
export interface PhaseRecord {
  phase: number; title: string; planned: { provider: string; model: string }; actual: { provider: string; model: string } | null;
  status: PhaseStatus; runnerExit: number | null; runnerTail: string; commit: string | null; filesChanged: string[];
  check: { command: string; exit: number | null; tail: string; timedOut: boolean } | null;
  review: { model: string; independentOfWriter: boolean; status: string; findings: number; blocking: number; artifactPath?: string; summary: string } | null;
}

export type RunMode = "auto" | "step";
export interface ImplementRequest {
  cwd: string; specPath: string; mode: RunMode; phases?: number[]; checkCommand?: string; provider?: "claude" | "codex"; autoRoute: boolean; taskId: string;
}
export interface Deps {
  /** Pause point in step mode. Returns false to stop. */
  confirmPhase: (p: PlannedPhase) => Promise<boolean>;
  /** Independent review of a phase diff. Throw to signal the review could not run. */
  review: (a: { worktreeDir: string; phase: PlannedPhase; writerFamily: string; diff: string; files: string[] }) => Promise<NonNullable<PhaseRecord["review"]>>;
  progress?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface ImplementConfig { e3dCodeBin: string; phaseTimeoutSec: number; checkTimeoutSec: number; reviewMaxDiffChars: number; }

const tail = (s: string, n = 1500) => (s.length > n ? "…" + s.slice(-n) : s).trim();
const flags = (req: ImplementRequest) => [...(req.provider ? ["--provider", req.provider] : []), ...(req.autoRoute ? ["--auto-route"] : [])];

/** Read-only: what e3d-code would run for each phase. */
export async function planRun(req: Pick<ImplementRequest, "cwd" | "specPath" | "provider" | "autoRoute">, cfg: ImplementConfig): Promise<{ phases: PlannedPhase[]; raw: string }> {
  const r = await run(cfg.e3dCodeBin, [req.specPath, "--list", ...flags(req as ImplementRequest)], { cwd: req.cwd, timeoutSec: 300 });
  if (r.code !== 0) throw new Error(`e3d-code --list failed (exit ${r.code}): ${tail(r.stderr || r.stdout, 600)}`);
  const phases = parseList(r.stdout);
  if (!phases.length) throw new Error("e3d-code --list returned no phases; check the spec's '## Phase N - Title' headings");
  return { phases, raw: r.stdout };
}

export interface RunResult { status: "completed" | "stopped" | "paused" | "cancelled"; reason: string; worktree: Worktree; phases: PhaseRecord[]; artifactPath?: string; plan: PlannedPhase[]; }

/** Run phases one at a time through e3d-code in an isolated worktree. Each phase is committed, checked, and reviewed by a different family before the next starts. */
export async function runImplementation(req: ImplementRequest, cfg: ImplementConfig, stateDir: string, deps: Deps): Promise<RunResult> {
  const say = deps.progress ?? (() => {});
  const wt = createWorktree(req.cwd, stateDir, req.taskId);
  const spec = stageSpec(wt, req.specPath, req.cwd);
  // Commit the staged spec on its own so it never appears in a phase's diff or hides a no-change phase.
  git(wt.dir, "add", "--", spec);
  if (git(wt.dir, "diff", "--cached", "--name-only").trim()) git(wt.dir, "-c", "user.name=e3d-loop", "-c", "user.email=loop@localhost", "commit", "-q", "-m", "loop: stage spec");
  const { phases: all } = await planRun({ cwd: wt.dir, specPath: spec, provider: req.provider, autoRoute: req.autoRoute }, cfg);
  const todo = req.phases?.length ? all.filter((p) => req.phases!.includes(p.phase)) : all;
  const out: PhaseRecord[] = [];
  const finish = (status: RunResult["status"], reason: string): RunResult => {
    const res: RunResult = { status, reason, worktree: wt, phases: out, plan: all };
    res.artifactPath = saveArtifact(stateDir, repoKey(wt.repoRoot), "impl-" + req.taskId, { schemaVersion: 1, taskId: req.taskId, mode: req.mode, spec, checkCommand: req.checkCommand ?? null, ...res });
    return res;
  };
  if (!todo.length) return finish("stopped", "no matching phases");

  for (const p of todo) {
    if (deps.signal?.aborted) return finish("cancelled", "cancelled by user");
    if (req.mode === "step" && !(await deps.confirmPhase(p))) return finish("paused", `stopped before phase ${p.phase} at your request`);
    say(`phase ${p.phase}/${all[all.length - 1].phase}: ${p.title} (${p.provider}/${p.model})`);
    const rec: PhaseRecord = { phase: p.phase, title: p.title, planned: { provider: p.provider, model: p.model }, actual: null, status: "passed", runnerExit: null, runnerTail: "", commit: null, filesChanged: [], check: null, review: null };
    out.push(rec);

    const r = await run(cfg.e3dCodeBin, [spec, String(p.phase), ...flags(req)], { cwd: wt.dir, timeoutSec: cfg.phaseTimeoutSec });
    rec.runnerExit = r.code; rec.runnerTail = tail(r.stdout + "\n" + r.stderr);
    const mf = readManifest(wt.dir, p.phase);
    if (mf) rec.actual = { provider: mf.provider, model: mf.model };
    if (r.code !== 0) { rec.status = "runner_failed"; return finish("stopped", `phase ${p.phase}: e3d-code exited ${r.code}${r.timedOut ? " (timed out)" : ""}`); }

    // Commit this phase alone so it can be diffed, reviewed and reverted. e3d-code's own state dir is not part of the work.
    git(wt.dir, "add", "-A", "--", ".", ":!.e3d-code", ":!.spec2code");
    const staged = git(wt.dir, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
    // A phase that exits 0 but changes nothing counts as a failure: e3d-code can report success when a tool call was silently denied.
    if (!staged.length) { rec.status = "no_changes"; return finish("stopped", `phase ${p.phase} exited 0 but changed no files`); }
    git(wt.dir, "-c", "user.name=e3d-loop", "-c", "user.email=loop@localhost", "commit", "-q", "-m", `loop: phase ${p.phase} ${p.title}`.slice(0, 200));
    rec.commit = git(wt.dir, "rev-parse", "HEAD").trim(); rec.filesChanged = staged;

    if (req.checkCommand) {
      say(`phase ${p.phase}: running check`);
      const c = await run("sh", ["-c", req.checkCommand], { cwd: wt.dir, timeoutSec: cfg.checkTimeoutSec });
      rec.check = { command: req.checkCommand, exit: c.code, tail: tail(c.stdout + "\n" + c.stderr), timedOut: c.timedOut };
      if (c.code !== 0) { rec.status = "check_failed"; return finish("stopped", `phase ${p.phase}: check failed (exit ${c.code}${c.timedOut ? ", timed out" : ""})`); }
    }

    const writerFamily = familyOf(rec.actual?.provider ?? p.provider);
    const diff = git(wt.dir, "show", "--format=", "--patch", "HEAD").slice(0, cfg.reviewMaxDiffChars);
    say(`phase ${p.phase}: independent review`);
    try {
      rec.review = await deps.review({ worktreeDir: wt.dir, phase: p, writerFamily, diff, files: staged });
    } catch (e: any) { rec.status = "review_unavailable"; return finish("stopped", `phase ${p.phase}: review could not run (${String(e?.message ?? e).slice(0, 200)}); not continuing without one`); }
    if (rec.review.blocking > 0) { rec.status = "review_blocked"; return finish("stopped", `phase ${p.phase}: reviewer raised ${rec.review.blocking} confirmed high-severity finding(s)`); }
    rec.status = "passed";
  }
  return finish("completed", `${todo.length} phase(s) passed their checks and review`);
}

export function formatRun(r: RunResult): string {
  const L = [`## E3D Loop implementation: ${r.status.toUpperCase()}`, r.reason, `Worktree: ${r.worktree.dir} (branch ${r.worktree.branch}, base ${r.worktree.baseRevision.slice(0, 10)}). Nothing was merged or pushed; your working tree is untouched.`, ""];
  for (const p of r.phases) {
    const used = p.actual ? `${p.actual.provider}/${p.actual.model}` : `${p.planned.provider}/${p.planned.model} (planned; runner recorded nothing)`;
    L.push(`- Phase ${p.phase} ${p.title}: **${p.status}**. Writer ${used}. Files: ${p.filesChanged.join(", ") || "none"}.`);
    if (p.check) L.push(`  check \`${p.check.command}\` -> exit ${p.check.exit}`);
    if (p.review) L.push(`  review by ${p.review.model} (${p.review.independentOfWriter ? "different family from writer" : "NOT independent of writer"}): ${p.review.status}, ${p.review.findings} finding(s), ${p.review.blocking} blocking. ${p.review.summary.slice(0, 200)}`);
  }
  const notRun = r.plan.filter((x) => !r.phases.some((p) => p.phase === x.phase)).map((x) => x.phase);
  if (notRun.length) L.push("", `Not run: phase(s) ${notRun.join(", ")}.`);
  L.push("", "Review claims are the reviewer's, with quotes checked against the code; checks are only as good as the command you gave. Artifact: " + r.artifactPath);
  return L.join("\n");
}
