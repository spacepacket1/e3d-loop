import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The six model families Loop works with, and what each one can do. Availability checks look for the
 *  presence of a credential file, env var, binary or endpoint only; they never read or print a secret. */
export interface ProviderInfo {
  id: "claude" | "openai" | "gemini" | "grok" | "qwen" | "devin";
  label: string;
  /** model = reachable through Pi as foreground/helper/reviewer; cli-agent = an agent CLI, not a model API. */
  kind: "model" | "cli-agent";
  /** Pi provider id, for kind=model. */
  piProvider?: string;
  /** e3d-code runner that can write code with this family (e3d-code supports only claude and codex today). */
  codeRunner?: "claude" | "codex";
  envVar?: string;
  keyFile?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "claude", label: "Claude", kind: "model", piProvider: "anthropic", codeRunner: "claude", envVar: "ANTHROPIC_API_KEY", keyFile: "anthropic-api-key" },
  { id: "openai", label: "OpenAI", kind: "model", piProvider: "openai", codeRunner: "codex", envVar: "OPENAI_API_KEY", keyFile: "openai-api-key" },
  { id: "gemini", label: "Gemini", kind: "model", piProvider: "google", envVar: "GEMINI_API_KEY", keyFile: "gemini-api-key" },
  { id: "grok", label: "Grok", kind: "model", piProvider: "xai", envVar: "XAI_API_KEY", keyFile: "xai-api-key" },
  { id: "qwen", label: "Qwen (local)", kind: "model", piProvider: "qwen-local" },
  { id: "devin", label: "Devin", kind: "cli-agent" },
];

export const QWEN_ENDPOINT = process.env.E3D_LOOP_QWEN_ENDPOINT || "http://127.0.0.1:5050/v1";
export const KEY_DIR = process.env.E3D_LOOP_KEY_DIR || join(homedir(), ".config", "e3d-pilot");

export interface ProviderStatus { id: ProviderInfo["id"]; label: string; ok: boolean; detail: string; role: string; }

/** Map a Pi "provider/model" string (or an e3d-code provider name) to its family id, e.g. anthropic/... -> claude. */
export function familyOf(ref: string | null | undefined): string {
  const head = String(ref ?? "").split("/")[0].toLowerCase();
  const hit = PROVIDERS.find((p) => p.id === head || p.piProvider === head || p.codeRunner === head);
  return hit ? hit.id : head || "unknown";
}

export function hasCredential(p: ProviderInfo, env = process.env, keyDir = KEY_DIR): boolean {
  if (p.envVar && env[p.envVar]) return true;
  return !!p.keyFile && existsSync(join(keyDir, p.keyFile));
}

function binOnPath(name: string): string | null {
  try { return execFileSync("which", [name], { encoding: "utf8" }).trim() || null; } catch { return null; }
}

export async function qwenReachable(endpoint = QWEN_ENDPOINT, timeoutMs = 2500): Promise<{ ok: boolean; model?: string }> {
  try {
    const r = await fetch(endpoint.replace(/\/$/, "") + "/models", { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false };
    const j: any = await r.json();
    return { ok: true, model: j?.data?.[0]?.id };
  } catch { return { ok: false }; }
}

/** Does ~/.pi/agent/models.json declare the local Qwen provider? */
export function qwenConfiguredInPi(agentDir = join(homedir(), ".pi", "agent")): boolean {
  try { return !!JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")).providers?.["qwen-local"]; } catch { return false; }
}

export async function providerStatuses(opts: { env?: NodeJS.ProcessEnv; keyDir?: string; agentDir?: string; qwenEndpoint?: string; probe?: boolean } = {}): Promise<ProviderStatus[]> {
  const env = opts.env ?? process.env; const out: ProviderStatus[] = [];
  for (const p of PROVIDERS) {
    const role = p.codeRunner ? `writes code via e3d-code (${p.codeRunner} CLI); reviewer/helper via Pi` : p.kind === "model" ? "helper/reviewer via Pi (cannot write code through e3d-code yet)" : "agent CLI; not wired as writer or reviewer yet";
    if (p.id === "qwen") {
      const ep = opts.probe === false ? { ok: false } : await qwenReachable(opts.qwenEndpoint);
      const pi = qwenConfiguredInPi(opts.agentDir);
      out.push({ id: p.id, label: p.label, role, ok: ep.ok && pi, detail: `${ep.ok ? `endpoint up (${(ep as any).model ?? "model unknown"})` : "endpoint not reachable"}; ${pi ? "declared in Pi models.json" : "NOT declared in ~/.pi/agent/models.json"}` });
    } else if (p.id === "devin") {
      const bin = binOnPath("devin");
      out.push({ id: p.id, label: p.label, role, ok: !!bin, detail: bin ? `devin CLI at ${bin}` : "devin CLI not on PATH" });
    } else {
      const key = hasCredential(p, env, opts.keyDir);
      const cli = p.codeRunner ? binOnPath(p.codeRunner) : "n/a";
      out.push({ id: p.id, label: p.label, role, ok: key && !!cli, detail: `${key ? "credential found" : "no credential found"}${p.codeRunner ? `; ${p.codeRunner} CLI ${cli ? "found" : "NOT found"}` : ""}` });
    }
  }
  return out;
}

export function formatProviders(s: ProviderStatus[]): string {
  return s.map((x) => `[${x.ok ? "ok  " : "warn"}] ${x.label}: ${x.detail} (${x.role})`).join("\n");
}
