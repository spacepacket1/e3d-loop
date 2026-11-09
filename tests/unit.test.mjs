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
