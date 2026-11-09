import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getAgentDir, VERSION, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig } from "./config.ts";

export interface Check { name: string; status: "ok" | "warn" | "fail"; detail: string; }
const ROOT = join(import.meta.dirname, "..");

function mcpServers(cwd: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of [join(getAgentDir(), "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
    try { Object.assign(out, JSON.parse(readFileSync(p, "utf8")).mcpServers ?? {}); } catch { /* absent */ }
  }
  return out;
}

export async function runDoctor(opts: { cwd: string; connect?: boolean; pi?: string }): Promise<Check[]> {
  const c: Check[] = [];
  const pinned = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
  c.push({ name: "node", status: Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "fail", detail: process.version + " (Pi needs >=22.19)" });
  c.push({ name: "pi version", status: VERSION === pinned ? "ok" : "warn", detail: `running ${VERSION}, E3D Loop tested against ${pinned}` });
  c.push({ name: "execution profile", status: "warn", detail: "local-trusted: Pi has no sandbox; tools run as you on this machine. No isolated profile exists yet." });

  const servers = mcpServers(opts.cwd);
  for (const [label, re] of [["Pilot MCP", /pilot|e3d-?mcp/i], ["Brain MCP", /brain/i]] as const) {
    const hit = Object.entries(servers).find(([n]) => re.test(n));
    if (!hit) c.push({ name: label, status: "warn", detail: `not configured in ${join(getAgentDir(), "mcp.json")}; see config/mcp.example.json (single-model work still fine)` });
    else if (hit[1].enabled === false) c.push({ name: label, status: "warn", detail: `${hit[0]} is disabled` });
    else {
      const cmd = hit[1].command ? String(hit[1].command).replace(/^~\//, process.env.HOME + "/") : null;
      const ok = !cmd || existsSync(cmd) || which(cmd);
      c.push({ name: label, status: ok ? "ok" : "fail", detail: `${hit[0]} configured (${hit[1].url ? "http" : "stdio"})${ok ? "" : `; command not found: ${cmd}`}` });
    }
  }
  if (opts.connect && opts.pi) {
    try { const o = execFileSync(process.execPath, [opts.pi, "mcp", "list"], { encoding: "utf8", timeout: 60000 }); c.push({ name: "pi mcp list", status: "ok", detail: o.trim().split("\n").slice(0, 12).join(" | ") }); }
    catch (e: any) { c.push({ name: "pi mcp list", status: "fail", detail: String(e.stdout || e.message).trim().split("\n").slice(0, 6).join(" | ") }); }
  }

  const cfg = loadConfig();
  if (!cfg.helper.model) c.push({ name: "helper model", status: "warn", detail: `not set in ${configPath()}; helper will reuse the foreground model and be reported as NOT independent` });
  else {
    try {
      const mr = await ModelRuntime.create(); const [p, ...r] = cfg.helper.model.split("/");
      const m = mr.getModel(p, r.join("/"));
      const avail = m ? (await mr.getAvailable()).some((a: any) => a.provider === m.provider && a.id === m.id) : false;
      c.push({ name: "helper model", status: m && avail ? "ok" : m ? "warn" : "fail", detail: m ? `${cfg.helper.model}${avail ? " (credentials available)" : " (known, but no credentials found)"}` : `${cfg.helper.model} is not a known model` });
    } catch (e: any) { c.push({ name: "helper model", status: "fail", detail: String(e.message) }); }
  }
  c.push({ name: "web search for private code", status: cfg.allowWebSearch ? "warn" : "ok", detail: cfg.allowWebSearch ? "allowWebSearch=true: Pilot debates may forward queries to the web" : "off (default); Loop does not enable Pilot web search" });
  try {
    const out = execFileSync("which", ["-a", "e3d"], { encoding: "utf8" }).trim().split("\n");
    const other = out.filter((p) => !p.includes("e3d-loop"));
    c.push({ name: "`e3d` command", status: other.length ? "warn" : "ok", detail: other.length ? `another e3d on PATH: ${other.join(", ")}` : out[0] });
  } catch { c.push({ name: "`e3d` command", status: "warn", detail: "not on PATH yet; run `npm link` in the repo or use bin/e3d.mjs" }); }
  return c;
}
function which(cmd: string) { try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } }

export function formatDoctor(c: Check[]): string {
  const icon = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  return c.map((x) => `[${icon[x.status]}] ${x.name}: ${x.detail}`).join("\n");
}
