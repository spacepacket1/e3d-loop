import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";

export interface EvidenceRef { file: string; line?: number; quote: string; }
export interface Finding { claim: string; severity?: string; evidence: EvidenceRef[]; }
export type Check = "confirmed" | "quote-not-found" | "file-missing" | "path-escape";
export interface CheckedEvidence extends EvidenceRef { check: Check; }
export interface CheckedFinding extends Omit<Finding, "evidence"> { evidence: CheckedEvidence[]; verified: boolean; }

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseHelperOutput(text: string): { findings: Finding[]; unresolved: string[]; summary: string; parsed: boolean } {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  const summary = (last ? text.slice(0, last.index) : text).trim();
  if (!last) return { findings: [], unresolved: [], summary, parsed: false };
  try {
    const j = JSON.parse(last[1]);
    const findings: Finding[] = (Array.isArray(j.findings) ? j.findings : []).filter((f: any) => f && typeof f.claim === "string")
      .map((f: any) => ({ claim: f.claim, severity: typeof f.severity === "string" ? f.severity : undefined,
        evidence: (Array.isArray(f.evidence) ? f.evidence : []).filter((e: any) => e && typeof e.file === "string" && typeof e.quote === "string")
          .map((e: any) => ({ file: e.file, line: Number.isInteger(e.line) ? e.line : undefined, quote: e.quote })) }));
    return { findings, unresolved: (Array.isArray(j.unresolved) ? j.unresolved : []).map(String), summary, parsed: true };
  } catch { return { findings: [], unresolved: [], summary, parsed: false }; }
}

/** Loop's own observation: does the quoted text actually exist in the frozen snapshot? (Says nothing about whether the claim is right.) */
export function checkEvidence(snapDir: string, ev: EvidenceRef): Check {
  const base = realpathSync(snapDir);
  const p = resolve(base, ev.file);
  if (p !== base && !p.startsWith(base + sep)) return "path-escape";
  let body: string; try { body = readFileSync(p, "utf8"); } catch { return "file-missing"; }
  const q = norm(ev.quote);
  if (!q) return "quote-not-found";
  if (ev.line) {
    const lines = body.split("\n");
    const near = norm(lines.slice(Math.max(0, ev.line - 4), ev.line + 3).join(" "));
    if (near.includes(q)) return "confirmed";
  }
  return norm(body).includes(q) ? "confirmed" : "quote-not-found";
}

export function checkFindings(snapDir: string, findings: Finding[]): CheckedFinding[] {
  return findings.map((f) => {
    const evidence = f.evidence.map((e) => ({ ...e, check: checkEvidence(snapDir, e) }));
    return { ...f, evidence, verified: evidence.length > 0 && evidence.every((e) => e.check === "confirmed") };
  });
}

export function repoKey(repoRoot: string): string { return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16); }

export function saveArtifact(stateDir: string, key: string, id: string, record: unknown): string {
  const dir = join(stateDir, key, "evidence");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  return file;
}
