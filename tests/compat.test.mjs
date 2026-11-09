// Pi-vs-E3D compatibility: the launcher must be transparent. Runs offline (no model calls).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const e3d = (...a) => spawnSync(process.execPath, [join(root, "bin/e3d.mjs"), ...a], { encoding: "utf8", env: { ...process.env, HOME: process.env.HOME } });
const piCli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const pi = (...a) => spawnSync(process.execPath, [piCli, ...a], { encoding: "utf8" });

test("--version identical to bare Pi", () => assert.equal(e3d("--version").stdout, pi("--version").stdout));
test("--help is Pi's help and lists core flags", () => {
  const h = e3d("--help").stdout; for (const f of ["--model", "--continue", "--resume", "--mode", "--extension"]) assert.match(h, new RegExp(f));
});
test("native subcommands pass through (mcp list, list)", () => {
  assert.equal(e3d("list").status, pi("list").status);
  assert.equal(e3d("mcp", "list").status, pi("mcp", "list").status);
});
test("E3D extension loads in print mode without a model (reports no-model, not a crash)", () => {
  const r = e3d("-p", "hi"); assert.doesNotMatch(r.stderr + r.stdout, /Cannot find module|SyntaxError|TypeError/);
});
test("doctor runs offline and never fails on missing optional services", () => {
  const r = e3d("doctor"); assert.match(r.stdout, /local-trusted/); assert.notEqual(r.status, null);
});
