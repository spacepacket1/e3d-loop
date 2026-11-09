#!/usr/bin/env node
// Thin launcher: runs the pinned Pi CLI with the E3D Loop package loaded. Every other argument passes
// through to Pi untouched, so all Pi commands/flags/modes (-p, --mode rpc, mcp, install, ...) keep working.
// Only `e3d doctor` and `e3d --e3d-help` are handled here.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The package's exports map hides package.json, so resolve the main entry and walk up to the package root.
let piPkg = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
while (!existsSync(join(piPkg, "package.json")) || JSON.parse(readFileSync(join(piPkg, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") piPkg = dirname(piPkg);
const piCli = join(piPkg, JSON.parse(readFileSync(join(piPkg, "package.json"), "utf8")).bin.pi);
const args = process.argv.slice(2);

if (args[0] === "doctor") {
  const { runDoctor, formatDoctor } = await import("../src/doctor.ts");
  const checks = await runDoctor({ cwd: process.cwd(), connect: args.includes("--connect"), pi: piCli });
  console.log(formatDoctor(checks));
  process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
}
if (args[0] === "--e3d-help") { console.log("e3d = pinned Pi + E3D Loop extension. `e3d doctor [--connect]` checks setup; everything else is Pi (`e3d --help`)."); process.exit(0); }

const depth = Number(process.env.E3D_LOOP_DEPTH ?? "0") + 1;
// Pi's shell subcommands never load extensions and must come first on the command line, so pass them through untouched.
const PI_SUBCOMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]);
const piArgs = PI_SUBCOMMANDS.has(args[0]) ? args : ["-e", root, ...args];
const child = spawn(process.execPath, [piCli, ...piArgs], { stdio: "inherit", env: { ...process.env, E3D_LOOP_DEPTH: String(depth) } });
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 128 : 0)));
