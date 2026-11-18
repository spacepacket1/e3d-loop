import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHelperOutput, checkEvidence, checkFindings } from "../src/evidence.ts";
import { createSnapshot, disposeSnapshot } from "../src/snapshot.ts";
import { assertDepth, HELPER_TOOLS } from "../src/helper.ts";
import { loadConfig } from "../src/config.ts";

const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "loop-test-"));
  const g = (...a) => execFileSync("git", ["-C", d, ...a], { stdio: "ignore" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  mkdirSync(join(d, "src")); writeFileSync(join(d, "src/a.js"), "const x = 1;\nfunction bug() { return x / 0; }\n");
  writeFileSync(join(d, ".env"), "SECRET=1"); writeFileSync(join(d, "key.pem"), "k");
  g("add", "src/a.js"); g("commit", "-qm", "init");
  writeFileSync(join(d, "src/a.js"), "const x = 2;\nfunction bug() { return x / 0; }\n"); // dirty edit
  writeFileSync(join(d, "new.txt"), "untracked");
  symlinkSync("/etc/passwd", join(d, "link"));
  return d;
};

test("snapshot includes dirty+untracked, excludes secrets and symlinks, leaves tree untouched", () => {
  const d = repo(); const s = createSnapshot(d, { maxFiles: 100, maxBytes: 1e6 });
  assert.equal(readFileSync(join(s.dir, "src/a.js"), "utf8").startsWith("const x = 2"), true);
  assert.ok(existsSync(join(s.dir, "new.txt")));
  assert.ok(!existsSync(join(s.dir, ".env")) && !existsSync(join(s.dir, "key.pem")) && !existsSync(join(s.dir, "link")));
  assert.ok(s.dirty && s.excluded.includes(".env"));
  assert.equal(readFileSync(join(d, "src/a.js"), "utf8").startsWith("const x = 2"), true);
  disposeSnapshot(s); assert.ok(!existsSync(s.dir));
});

test("snapshot limits are enforced", () => {
  assert.throws(() => createSnapshot(repo(), { maxFiles: 1, maxBytes: 1e6 }), /exceeds limits/);
});

test("evidence: confirmed vs fabricated quote vs path escape", () => {
  const d = repo(); const s = createSnapshot(d, { maxFiles: 100, maxBytes: 1e6 });
  assert.equal(checkEvidence(s.dir, { file: "src/a.js", line: 2, quote: "return x / 0" }), "confirmed");
  assert.equal(checkEvidence(s.dir, { file: "src/a.js", line: 2, quote: "return x / 1" }), "quote-not-found");
  assert.equal(checkEvidence(s.dir, { file: "nope.js", quote: "x" }), "file-missing");
  assert.equal(checkEvidence(s.dir, { file: "../../etc/passwd", quote: "root" }), "path-escape");
  const [f] = checkFindings(s.dir, [{ claim: "c", evidence: [{ file: "src/a.js", line: 2, quote: "x / 0" }, { file: "src/a.js", quote: "invented" }] }]);
  assert.equal(f.verified, false);
  disposeSnapshot(s);
});

test("helper output parsing tolerates garbage", () => {
  const ok = parseHelperOutput('Summary here.\n```json\n{"findings":[{"claim":"a","evidence":[{"file":"f","line":3,"quote":"q"}]},{"nope":1}],"unresolved":["u"]}\n```');
  assert.equal(ok.parsed, true); assert.equal(ok.findings.length, 1); assert.deepEqual(ok.unresolved, ["u"]);
  assert.equal(parseHelperOutput("no block").parsed, false);
  assert.equal(parseHelperOutput("```json\n{bad\n```").parsed, false);
});

test("helper is read-only and recursion is refused", () => {
  assert.ok(!HELPER_TOOLS.some((t) => ["bash", "edit", "write"].includes(t)));
  assert.doesNotThrow(() => assertDepth({ E3D_LOOP_DEPTH: "1" }));
  assert.throws(() => assertDepth({ E3D_LOOP_DEPTH: "2" }), /nested delegation/);
});

test("config defaults: web search off, no helper model unless configured", () => {
  const c = loadConfig("/nonexistent/config.json");
  assert.equal(c.allowWebSearch, false); assert.equal(c.helper.model, null);
});

import { confineToSnapshot } from "../src/helper.ts";
test("confinement blocks absolute paths, .. escapes and symlink escapes; allows inside", () => {
  const d = repo(); const s = createSnapshot(d, { maxFiles: 100, maxBytes: 1e6 });
  assert.equal(confineToSnapshot(s.dir, { path: "src/a.js" }), null);
  assert.equal(confineToSnapshot(s.dir, {}), null);
  assert.match(confineToSnapshot(s.dir, { path: "/etc/hosts" }), /outside/);
  assert.match(confineToSnapshot(s.dir, { path: "../../etc/hosts" }), /outside/);
  assert.match(confineToSnapshot(s.dir, { path: "~" }), /outside/);
  assert.match(confineToSnapshot(s.dir, { path: "~/.ssh" }), /outside/);
  symlinkSync("/etc", join(s.dir, "sneaky"));
  assert.match(confineToSnapshot(s.dir, { path: "sneaky/hosts" }), /outside/);
  disposeSnapshot(s);
});

// ---- loop_implement / providers ----
import { parseList, readManifest, runImplementation, createWorktree } from "../src/implement.ts";
import { familyOf, PROVIDERS, hasCredential, providerStatuses } from "../src/providers.ts";
import { chmodSync } from "node:fs";

test("parseList reads e3d-code --list output and ignores noise", () => {
  const rows = parseList("warning: x\nPhase 1\tcodex\tgpt-5.4-mini\tCore Parser\nPhase 12\tclaude\tsonnet\tReport: Writer\n");
  assert.deepEqual(rows, [{ phase: 1, provider: "codex", model: "gpt-5.4-mini", title: "Core Parser" }, { phase: 12, provider: "claude", model: "sonnet", title: "Report: Writer" }]);
});

test("familyOf maps Pi providers and e3d-code runners to model families", () => {
  assert.equal(familyOf("anthropic/claude-sonnet-5-5"), "claude"); assert.equal(familyOf("claude"), "claude");
  assert.equal(familyOf("openai/gpt-5.5"), "openai"); assert.equal(familyOf("codex"), "openai");
  assert.equal(familyOf("google/gemini-3"), "gemini"); assert.equal(familyOf("xai/grok-4"), "grok"); assert.equal(familyOf("qwen-local/x"), "qwen");
  assert.equal(PROVIDERS.filter((p) => p.codeRunner).map((p) => p.id).join(), "claude,openai");
});

test("credential check finds key files without reading them", () => {
  const dir = mkdtempSync(join(tmpdir(), "keys-")); writeFileSync(join(dir, "xai-api-key"), "SECRET"); chmodSync(join(dir, "xai-api-key"), 0o000);
  const grok = PROVIDERS.find((p) => p.id === "grok"); const gem = PROVIDERS.find((p) => p.id === "gemini");
  assert.equal(hasCredential(grok, {}, dir), true); assert.equal(hasCredential(gem, {}, dir), false); assert.equal(hasCredential(gem, { GEMINI_API_KEY: "x" }, dir), true);
});

test("provider statuses report all six without probing the network when probe=false", async () => {
  const s = await providerStatuses({ env: {}, keyDir: mkdtempSync(join(tmpdir(), "k-")), agentDir: mkdtempSync(join(tmpdir(), "a-")), probe: false });
  assert.deepEqual(s.map((x) => x.id), ["claude", "openai", "gemini", "grok", "qwen", "devin"]);
  assert.equal(s.find((x) => x.id === "qwen").ok, false);
});

// A fake e3d-code that records what it was asked to run and writes a file per phase. FAIL=n makes phase n exit 1; NOOP=n changes nothing.
const fakeCode = (dir) => {
  const f = join(dir, "fake-e3d-code");
  writeFileSync(f, `#!/bin/bash
spec="$1"; shift
if [[ "$1" == "--list" ]]; then printf 'Phase 1\\tclaude\\tsonnet\\tAlpha\\nPhase 2\\tcodex\\tgpt-5.4\\tBeta\\nPhase 3\\tclaude\\topus\\tGamma\\n'; exit 0; fi
n="$1"; mkdir -p .e3d-code
[[ "$n" == "$FAIL" ]] && { printf '%s\\t%s\\t%s\\tT\\tclaude\\tsonnet\\tx\\t0\\t1\\n' now "$spec" "$n" >> .e3d-code/manifest.tsv; exit 1; }
[[ "$n" == "$NOOP" ]] || echo "phase $n" > "out$n.txt"
prov=claude; [[ "$n" == 2 ]] && prov=codex
printf '%s\\t%s\\t%s\\tT\\t%s\\tm\\tx\\t0\\t0\\n' now "$spec" "$n" "$prov" >> .e3d-code/manifest.tsv
`); chmodSync(f, 0o755); return f;
};
const mkRepo = () => { const d = repo(); const g = (...a) => execFileSync("git", ["-C", d, ...a], { stdio: "ignore" }); g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "all"); writeFileSync(join(d, "spec.md"), "## Phase 1 - Alpha\n"); g("add", "spec.md"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "spec"); return d; };
const cfgFor = (bin) => ({ e3dCodeBin: bin, phaseTimeoutSec: 30, checkTimeoutSec: 30, reviewMaxDiffChars: 5000 });
const goodReview = async (a) => ({ model: "x/y", independentOfWriter: true, status: "succeeded", findings: 0, blocking: 0, summary: "ok" });

test("implementation runs phases one at a time in an isolated worktree, committing each", async () => {
  const d = mkRepo(); const st = mkdtempSync(join(tmpdir(), "st-")); const bin = fakeCode(st); const seen = [];
  const r = await runImplementation({ cwd: d, specPath: "spec.md", mode: "auto", autoRoute: true, taskId: "t1", checkCommand: "test -f out1.txt || test -f out2.txt || test -f out3.txt" }, cfgFor(bin), st, { confirmPhase: async () => true, review: async (a) => { seen.push(a.writerFamily + ":" + a.files.join()); return goodReview(); } });
  assert.equal(r.status, "completed"); assert.deepEqual(r.phases.map((p) => p.status), ["passed", "passed", "passed"]);
  assert.deepEqual(seen, ["claude:out1.txt", "openai:out2.txt", "claude:out3.txt"]);
  assert.ok(r.phases.every((p) => p.commit)); assert.ok(!existsSync(join(d, "out1.txt")), "user tree untouched");
  assert.equal(execFileSync("git", ["-C", r.worktree.dir, "log", "--oneline", "-3"], { encoding: "utf8" }).split("\n").filter(Boolean).length, 3);
  assert.equal(r.phases[1].actual.provider, "codex");
});

test("step mode asks before every phase and stops when declined", async () => {
  const d = mkRepo(); const st = mkdtempSync(join(tmpdir(), "st-")); const bin = fakeCode(st); const asked = [];
  const r = await runImplementation({ cwd: d, specPath: "spec.md", mode: "step", autoRoute: false, taskId: "t2" }, cfgFor(bin), st, { confirmPhase: async (p) => { asked.push(p.phase); return p.phase < 2; }, review: goodReview });
  assert.equal(r.status, "paused"); assert.deepEqual(asked, [1, 2]); assert.equal(r.phases.length, 1);
});

test("a failing runner, a no-op phase, a failing check and a blocking review each stop the run", async () => {
  const st = mkdtempSync(join(tmpdir(), "st-")); const bin = fakeCode(st);
  const go = (env, extra = {}, rev = goodReview) => { Object.assign(process.env, { FAIL: "", NOOP: "" }, env); return runImplementation({ cwd: mkRepo(), specPath: "spec.md", mode: "auto", autoRoute: false, taskId: "t" + Math.random().toString(16).slice(2, 6), ...extra }, cfgFor(bin), st, { confirmPhase: async () => true, review: rev }); };
  let r = await go({ FAIL: "2" }); assert.equal(r.phases.at(-1).status, "runner_failed"); assert.equal(r.phases.length, 2);
  r = await go({ NOOP: "1" }); assert.equal(r.phases[0].status, "no_changes");
  r = await go({}, { checkCommand: "exit 3" }); assert.equal(r.phases[0].status, "check_failed"); assert.equal(r.phases[0].check.exit, 3); assert.equal(r.phases.length, 1);
  r = await go({}, {}, async () => ({ model: "x/y", independentOfWriter: true, status: "succeeded", findings: 1, blocking: 1, summary: "bad" })); assert.equal(r.phases[0].status, "review_blocked");
  r = await go({}, {}, async () => { throw new Error("no key"); }); assert.equal(r.phases[0].status, "review_unavailable"); assert.equal(r.status, "stopped");
  Object.assign(process.env, { FAIL: "", NOOP: "" });
});

test("manifest readback returns the runner's own record, ignoring dry runs", () => {
  const d = mkdtempSync(join(tmpdir(), "mf-")); mkdirSync(join(d, ".e3d-code"));
  writeFileSync(join(d, ".e3d-code/manifest.tsv"), "t\ts\t2\tT\tclaude\tsonnet\tm\t1\t0\nt\ts\t2\tT\tcodex\tgpt\tm\t0\t0\n");
  assert.equal(readManifest(d, 2).provider, "codex"); assert.equal(readManifest(d, 9), null);
});

test("sse shim re-emits a plain JSON completion as a stream and flattens list-shaped content", async () => {
  const { toSse } = await import("../bin/sse-shim.mjs");
  const sse = toSse({ id: "x", model: "m", choices: [{ finish_reason: "stop", message: { content: [{ type: "text", text: "po" }, { type: "text", text: "ng" }] } }], usage: { total_tokens: 3 } });
  const events = sse.split("\n\n").filter(Boolean);
  assert.equal(events.at(-1), "data: [DONE]");
  const first = JSON.parse(events[0].slice(6)); assert.equal(first.choices[0].delta.content, "pong");
  const last = JSON.parse(events[1].slice(6)); assert.equal(last.choices[0].finish_reason, "stop"); assert.equal(last.usage.total_tokens, 3);
});

test("default reviewers: every code-writing family has a reviewer from a different family", async () => {
  const { DEFAULTS } = await import("../src/config.ts");
  for (const p of PROVIDERS.filter((x) => x.codeRunner)) {
    const rev = DEFAULTS.implement.reviewers[p.id]; assert.ok(rev, `reviewer for ${p.id}`); assert.notEqual(familyOf(rev), p.id);
  }
});
