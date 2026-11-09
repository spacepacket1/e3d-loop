import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LoopConfig {
  helper: {
    /** "provider/modelId"; unset means "same model as foreground" and is reported as not independent. */
    model: string | null;
    thinking: "off" | "low" | "medium" | "high";
    timeoutSec: number;
    maxTurns: number;
    maxCostUsd: number;
    /** Backstop when a provider reports no cost: total input+output tokens across turns. */
    maxTokens: number;
    maxSnapshotFiles: number;
    maxSnapshotBytes: number;
  };
  /** Pilot web search must stay off for private-code consultations. */
  allowWebSearch: boolean;
}

export const DEFAULTS: LoopConfig = {
  helper: { model: null, thinking: "medium", timeoutSec: 300, maxTurns: 12, maxCostUsd: 0.5, maxTokens: 400_000, maxSnapshotFiles: 5000, maxSnapshotBytes: 50_000_000 },
  allowWebSearch: false,
};

export function configPath(): string {
  return process.env.E3D_LOOP_CONFIG || join(homedir(), ".config", "e3d-loop", "config.json");
}

export function stateDir(): string {
  return process.env.E3D_LOOP_STATE || join(homedir(), ".local", "state", "e3d-loop");
}

export function loadConfig(path = configPath()): LoopConfig {
  let user: any = {};
  try { user = JSON.parse(readFileSync(path, "utf8")); } catch { /* absent or invalid: defaults */ }
  return { ...DEFAULTS, ...user, helper: { ...DEFAULTS.helper, ...(user.helper || {}) } };
}
