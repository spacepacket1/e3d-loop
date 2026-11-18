import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0): initialize, tools/call, close. Enough to call
 *  Brain's tools from Loop without depending on Pi's internal MCP client. One server process per client. */
export interface McpServerSpec { command: string; args?: string[]; env?: Record<string, string>; }

const expand = (s: string, env = process.env) => s.replace(/^~(?=\/)/, homedir()).replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? "");

/** Find a server whose name matches `re` in Pi's MCP config (user, then project), with ~ and ${VAR} expanded. */
export function findMcpServer(re: RegExp, cwd: string, agentDir = join(homedir(), ".pi", "agent")): { name: string; spec: McpServerSpec } | null {
  let found: [string, any] | null = null;
  for (const p of [join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
    try { for (const [n, v] of Object.entries<any>(JSON.parse(readFileSync(p, "utf8")).mcpServers ?? {})) if (re.test(n) && v.command && v.enabled !== false) found = [n, v]; } catch { /* absent */ }
  }
  if (!found) return null;
  const [name, v] = found;
  return { name, spec: { command: expand(v.command), args: (v.args ?? []).map((a: string) => expand(a)), env: Object.fromEntries(Object.entries<string>(v.env ?? {}).map(([k, x]) => [k, expand(x)])) } };
}

export class McpClient {
  private child: ReturnType<typeof spawn>; private buf = ""; private id = 0; private waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>(); private err = ""; closed = false;
  private timeoutMs: number;
  constructor(spec: McpServerSpec, timeoutMs = 30000) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(spec.command, spec.args ?? [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(spec.env ?? {}) } });
    this.child.stdout!.on("data", (d) => { this.buf += d; let i; while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (line) this.onLine(line); } });
    this.child.stderr!.on("data", (d) => { if (this.err.length < 4000) this.err += d; });
    const dead = (why: string) => { this.closed = true; for (const w of this.waiting.values()) w.rej(new Error(`${why}${this.err ? ": " + this.err.trim().slice(-300) : ""}`)); this.waiting.clear(); };
    this.child.on("error", (e) => dead(`MCP server failed to start (${e.message})`));
    this.child.on("close", () => dead("MCP server exited"));
  }
  private onLine(line: string) { let m: any; try { m = JSON.parse(line); } catch { return; } const w = this.waiting.get(m.id); if (!w) return; this.waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message ?? "MCP error")) : w.res(m.result); }
  private send(obj: any) { this.child.stdin!.write(JSON.stringify(obj) + "\n"); }
  private request(method: string, params: any): Promise<any> {
    if (this.closed) return Promise.reject(new Error("MCP server not running"));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiting.delete(id); rej(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`)); }, this.timeoutMs);
      this.waiting.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async init() { await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e3d-loop", version: "0.1" } }); this.send({ jsonrpc: "2.0", method: "notifications/initialized" }); return this; }
  async listTools(): Promise<string[]> { return ((await this.request("tools/list", {})).tools ?? []).map((t: any) => t.name); }
  /** Returns the tool's text content; throws if the tool reported isError. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args });
    const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return text;
  }
  close() { this.closed = true; try { this.child.stdin!.end(); this.child.kill("SIGTERM"); } catch { /* gone */ } }
}
