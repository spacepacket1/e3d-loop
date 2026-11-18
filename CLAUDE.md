# CLAUDE.md

Guide for AI agents (and people) changing E3D Loop. For what Loop is and how to use it, read [README.md](README.md) first; the design is in [docs/architecture.md](docs/architecture.md), and [docs/e3d-loop-spec.md](docs/e3d-loop-spec.md) is a roadmap far larger than what is built.

## What this repo is
A Pi package (one extension, one skill) plus a thin launcher, not a fork of Pi. Pi is pinned to an exact version. Loop adds: `loop_implement` (phased runs through e3d-code with per-phase check and cross-family review), shared Brain memory, `loop_investigate` (read-only helper), and a provider registry. Pilot, Brain and e3d-code are separate projects: fix problems in them in their own repos, never by copying or patching their logic here.

## Commands
- `npm test`: runs offline with no model calls and no network. Run it before every commit. It must pass.
- `node bin/e3d.mjs doctor`: reports Pi pin, Brain/Pilot MCP config, the six model families, and e3d-code.

## Code conventions (learned the hard way)
- **TypeScript runs directly under Node's type stripping.** There is no build step and no type checker (`tsc` is not installed). So: no enums, no namespaces, no constructor parameter properties (`constructor(private x)` crashes at load); use plain fields and annotations only. A wrong name or missing symbol is a runtime error, so exercise every new path in a test, not just load the file.
- ESM only, `node:` imports, relative imports end in `.ts`. No new runtime dependencies without a strong reason; the Brain client (`src/mcp-client.ts`) and the Qwen shim are deliberately dependency-free.
- Tests are `node --test` files in `tests/`. Use temp git repos, a **fake e3d-code** script and a **fake Brain MCP server that emits Brain's real wrapper format** (see `tests/unit.test.mjs`). Do not make tests call models.
- macOS note: tmp paths are symlinks (`/var` vs `/private/var`); compare real paths.

## Safety rules (do not weaken)
- **Never print, copy, log or commit credentials.** Key files (`~/.config/e3d-pilot/*`) are checked for existence only, never read into output. No keys in the repo, config examples, tests or artifacts.
- **Brain is advisory and read-only from Loop's side.** Retrieved notes are passed as labelled reference data, never as instructions. The only Brain write is `capture` to the review **inbox**, with explicit user confirmation (UI) or `E3D_LOOP_ALLOW_BRAIN_CAPTURE=1`. Do not edit the vault directly. Do not call `report_use` automatically: Loop cannot tell whether a model used a note, and "provided" must never be recorded as "helped".
- **`loop_implement` never merges or pushes**, runs in a separate git worktree, and asks the user for auto vs step mode. Non-interactive runs need `E3D_LOOP_ALLOW_UNATTENDED=1`. e3d-code writers run unattended and **there is no sandbox**: do not describe the worktree as isolation or the profile as safe.
- Helpers and reviewers are read-only (`read`, `grep`, `find`, `ls`), confined to a snapshot, with no MCP and no recursion (`E3D_LOOP_DEPTH`). Keep it so.
- A review that cannot return structured findings stops the run. Do not make Loop continue without a review.
- Reviewer findings are **claims**; only exit codes, commits and confirmed quotes are observations. Keep that distinction in code, reports and docs.

## Live testing
Real model runs spend credits, so do them deliberately and small. Use a throwaway git repo with a tiny two-phase spec and a cheap check command, and run `-p` mode with `</dev/null` (print mode hangs if stdin stays open). A launcher that loads keys at launch is described in `config/run.example.sh`; keep your own copy outside the repo. Qwen needs `node bin/sse-shim.mjs` running. Writers can read the whole disk, so a with-and-without-Brain comparison on a repo that exists on the machine is contaminated; say so rather than claiming memory helped.

## Honesty in docs and demos
This is an experiment. Claim only what the code or a real run shows, mark anything else UNVERIFIED, and keep the README Status section current when behavior changes. Do not describe unbuilt features (parallel helpers, isolation, Devin/Gemini/Grok/Qwen as code writers) as shipped.

## Workflow
Work on a branch and open it for review; do not merge or push to `main` unless the owner says to. Delete merged branches only when asked. Commit messages end with the attribution line the harness provides.

## Layout
```
bin/e3d.mjs            launcher (runs pinned Pi with this package; `doctor`)
bin/sse-shim.mjs       streaming shim for the local Qwen server
extensions/e3d-loop.ts the Pi extension: loop_implement, loop_investigate, /e3d-doctor
skills/e3d-loop/       guidance for the Pi agent that runs inside Loop (not for developing Loop)
src/implement.ts       phased runs: worktree, per-phase commit, check, review, stop rules
src/brain.ts           shared-memory packet, inbox lesson; src/mcp-client.ts minimal MCP client
src/providers.ts       the six model families and availability checks
src/helper.ts, snapshot.ts, evidence.ts   read-only helper, snapshot, quote checking
src/config.ts, doctor.ts                  config defaults, `e3d doctor`
```
