# Architecture decision and plan (milestone 1)

Spec: [e3d-loop-spec.md](e3d-loop-spec.md). Verified 2026-11-08 against Pi 1.5.0 (MIT, `@earendil-works/pi-coding-agent`, Node >=22.19).

## Decision
E3D Loop is **a Pi package plus a thin launcher**, not a fork. `bin/e3d.mjs` runs the pinned Pi CLI with `-e <this package>` and forwards every other argument unchanged (Pi's shell subcommands run untouched because they never load extensions). The package supplies one extension (`extensions/e3d-loop.ts`) and one skill. No Pi internals are touched; only documented extension and SDK APIs are used. No blocking Pi limitation was found, so there is no reason to fork.

## What supplies what
| Need | Supplied by Pi (verified in docs) | Supplied by E3D (existing) | New in this repo |
|---|---|---|---|
| Interactive TUI, tools, sessions, branching, compaction, steering, skills, themes, extensions | yes | | none |
| MCP client (stdio + streamable HTTP, OAuth, `/mcp`, `pi mcp`) | built in for the CLI | | none; config example only |
| Council, dissent, experts, quote/debate, pipeline | | Pilot MCP (`bin/e3d-mcp` local, pilot.e3d.ai hosted) | guidance text only |
| Memory search/read/capture/report_use | | Brain MCP (`e3d-brain mcp`) | guidance text only |
| Spec execution | | e3d-code, reached only via Pilot | nothing (deliberately) |
| Separate helper session, any configured model | SDK `createAgentSession`, `SessionManager`, `ModelRuntime` | | `loop_investigate` tool, snapshot, bounds, evidence check |
| Evidence/task references in the session | `pi.appendEntry` | | `e3d-loop/evidence` entries + JSON artifacts under `~/.local/state/e3d-loop` |
| Setup check | | | `e3d doctor`, `/e3d-doctor` |

## Safety properties implemented
- Helper reads a **frozen snapshot copy** (tracked + untracked, dirty edits included; symlinks, `.env*`, keys skipped). The user's tree is never modified.
- Helper tools: `read, grep, find, ls` only. It executes nothing. Pi's hook-based permission model is not a sandbox; the launcher and doctor label the profile **local-trusted**.
- Bounds: wall-clock timeout, max turns, max cost (observed or catalog estimate), snapshot size. No retries are added by Loop.
- Recursion: launcher increments `E3D_LOOP_DEPTH`; the tool refuses at depth >1. Helper sessions load no extensions (no MCP, no Pilot, no `loop_investigate`).
- Claims vs observation: the report labels all findings as helper claims; Loop independently checks that each quoted evidence string exists at the cited location (`quote confirmed` / `not found`). That is an observation about the quote, not the claim.
- Identity: actual provider/model are read from the assistant messages; the report says when the helper was **not** a different model than the foreground.
- Web search is not enabled by Loop; `doctor` warns if config allows it. Brain stays advisory (guidance says inbox only).

## Unverified assumptions / not done
- Helper live run needs model credentials in Pi (`/login` or env); see README. Tested offline only until then.
- Pilot hosted tool schemas differ from local; Loop asserts nothing about them yet (Phase 3 capability negotiation).
- Whether Pilot's `e3d_pilot_execute` honors `E3D_LOOP_DEPTH` is untested; today recursion is blocked on Loop's side only.
- Helper cost is Pi's catalog estimate unless the provider reports billed cost.
- SDK/RPC parity is not tested (launcher passes `--mode rpc` through; no test yet).
- Isolated profile, execution broker, receipts, SQLite coordinator, patch integration: Phase 2+.

## Phases
1. **(this milestone)** Pi + MCP config + guidance + one read-only helper + doctor + compat tests.
2. Policy broker/isolated profile, verification receipts, structured review cycles, budgets, recovery.
3. Pilot/Brain first-class: capability negotiation, handoff with ownership, provenance, report_use.
4. Parallel helpers, wider ecosystem. 5. Distribution.
