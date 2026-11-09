import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Snapshot { dir: string; digest: string; fileCount: number; bytes: number; baseRevision: string; dirty: boolean; excluded: string[]; }

const SECRET_NAME = /(^|\/)(\.env(\..*)?|id_[a-z0-9]+|.*\.(pem|key|p12|pfx)|\.npmrc|credentials(\.json)?)$/i;
const MAX_FILE = 1_000_000;

/**
 * Frozen, read-only-by-convention copy of the working tree (tracked + untracked, honoring .gitignore).
 * The user's tree is never touched; dirty edits are included so helpers see what the foreground sees.
 * Symlinks and secret-looking files are skipped. This is a data boundary, not an execution sandbox.
 */
export function createSnapshot(cwd: string, limits: { maxFiles: number; maxBytes: number }): Snapshot {
  const git = (...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const root = git("rev-parse", "--show-toplevel").trim();
  const names = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  const dir = mkdtempSync(join(tmpdir(), "e3d-loop-snap-"));
  const hash = createHash("sha256");
  const excluded: string[] = [];
  let fileCount = 0, bytes = 0;
  try {
    for (const rel of [...new Set(names)].sort()) {
      if (SECRET_NAME.test(rel)) { excluded.push(rel); continue; }
      const src = join(root, rel);
      let st; try { st = lstatSync(src); } catch { continue; } // deleted in working tree
      if (!st.isFile()) continue; // symlinks/dirs skipped
      if (st.size > MAX_FILE) { excluded.push(rel); continue; }
      if (++fileCount > limits.maxFiles || (bytes += st.size) > limits.maxBytes) throw new Error(`snapshot exceeds limits (${limits.maxFiles} files / ${limits.maxBytes} bytes); narrow the task or raise helper.maxSnapshot* in config`);
      const dst = join(dir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      hash.update(rel + "\0").update(readFileSync(dst)).update("\0");
    }
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  let baseRevision = "unknown"; try { baseRevision = git("rev-parse", "HEAD").trim(); } catch { /* no commits */ }
  let dirty: boolean;
  try { dirty = git("status", "--porcelain").trim().length > 0; } catch (e) { disposeSnapshot({ dir } as Snapshot); throw e; }
  return { dir, digest: hash.digest("hex"), fileCount, bytes, baseRevision, dirty, excluded };
}

export function disposeSnapshot(s: Snapshot) { rmSync(s.dir, { recursive: true, force: true }); }
