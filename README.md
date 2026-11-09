# E3D Loop

> **This is an experiment.** It demonstrates how the pieces of the E3D ecosystem can plug into a real, everyday terminal coding agent: [Pi](https://github.com/earendil-works/pi) for the agent, **E3D Pilot** for multi-model councils, **E3D Brain** for memory, and an independent second-model helper that returns evidence-checked findings. It is alpha software, built to learn what works, not a finished product. Read [Status](#status) before relying on it.

Loop is **not a fork of Pi**. It is a Pi package (one extension, one skill) plus a thin launcher. You get the full, unmodified Pi experience (pinned to 1.5.0), and Loop adds the E3D parts on top. If E3D services are unavailable, Pi still works as a normal single-model agent.

Full spec (the roadmap, far larger than what is built): [docs/e3d-loop-spec.md](docs/e3d-loop-spec.md). Design and what-supplies-what: [docs/architecture.md](docs/architecture.md). First live run: [docs/demo-2026-11-08.md](docs/demo-2026-11-08.md).

## The idea

Chat with one foreground agent. When it helps, that agent recruits bounded help from other models and from E3D services, and reports what it got back. More models are not automatically better, so the point of the experiment is to find out when they are, measured against one model working alone.

## What it demonstrates

| Component | Role here | How it connects | State |
|---|---|---|---|
| [Pi](https://github.com/earendil-works/pi) | The terminal agent: TUI, tools, sessions, branching, compaction, skills, themes, MCP client | npm dependency, pinned exactly; launched unmodified | Working |
| E3D Pilot | Multi-model debate with recorded dissent, experts, investigation, pipeline tools | Pi's built-in MCP client: local stdio server and hosted `https://pilot.e3d.ai/mcp` | Connected; a hosted debate ran; local pipeline tools not exercised |
| E3D Brain | Memory search and read with revision citations, inbox capture, `report_use` | Pi's MCP client over stdio | Connected and used; retrieval returned nothing useful in the demo |
| Independent helper | A separate read-only session on a snapshot of your repo, optionally a different model | Loop's `loop_investigate` tool (Pi SDK) | Working, about $0.30 per review in testing |
| e3d-code | Phased spec execution | Only through Pilot's pipeline, never directly | Not integrated |
| e3d-corp, e3d-creative | Business and creative workflows | none | Not integrated |

## Status

Verified: the launcher is transparent versus bare Pi (offline tests), snapshot and confinement logic, evidence checking, the bounds, the recursion guard, and one live end-to-end task (Brain + helper on a real repo).

Not verified or not built:

- **No isolation.** Execution is **local-trusted**: tools run as you on your machine. Pi has no sandbox, and Loop's checks are hooks, not an OS boundary. There is no isolated profile yet. Do not point it at untrusted repositories.
- **One data point.** One live demo shows the helper works. It does not show that a second model improves results. That comparison is the open question.
- **Pilot pipeline handoff** (propose/approve/implement), plan-token handling, and the check that Pilot honors Loop's recursion guard are untested.
- **RPC and SDK parity** with Pi is not tested; the launcher passes the flags through.
- **Helper cost** is Pi's catalog estimate unless the provider reports billed cost. Helper calls and Pilot debates spend real credits.

## Quick start

Requires Node 22.19 or newer.

```sh
git clone git@github.com:spacepacket1/e3d-loop.git && cd e3d-loop
npm install
npm link                     # optional: provides the `e3d` command (else: node bin/e3d.mjs)
e3d doctor --connect         # checks Pi pin, MCP servers, helper model, command conflicts
```

Give Pi a model credential one of two ways: run `e3d` and type `/login`, or export a provider key in your environment as [Pi documents](node_modules/@earendil-works/pi-coding-agent/docs/providers.md). To load keys from files at launch instead of your shell profile, copy [config/run.example.sh](config/run.example.sh), edit the paths, keep it outside the repo, and `chmod 700` it. Never commit keys.

Then run `e3d` in a repo. It behaves like `pi`: all flags, `-p`, `--mode rpc`, `-c`, `-r`, `mcp`, `install` pass through.

## Configure

Nothing here contains secrets.

**Models.** Pi picks the first available model unless told otherwise. Per launch: `e3d --model anthropic/claude-sonnet-5-5` (add `:high` for thinking level). In a session: `/model`. As a default, in `~/.pi/agent/settings.json`:
```json
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-5-5" }
```

**Pilot and Brain.** Copy entries from [config/mcp.example.json](config/mcp.example.json) into `~/.pi/agent/mcp.json`, or use `pi mcp add`. After editing while a session is open, run `/reload`. `/mcp` shows connection state and handles sign-in (`/mcp login <server>`). Local and hosted Pilot both expose `e3d_debate`; tools appear as `mcp__<server>__<tool>`, so name the server you want ("use e3d-pilot-hosted"). The hosted server spends your Pilot credits; ask for a quote first.

**Helper model.** Copy [config/e3d-loop.example.json](config/e3d-loop.example.json) to `~/.config/e3d-loop/config.json` and set `helper.model` to a *different* provider/model than your foreground one. If unset, the helper reuses the foreground model and every report says it is **not independent**. Bounds: `timeoutSec`, `maxTurns`, `maxCostUsd`, `maxTokens`, snapshot limits. `allowWebSearch` defaults to false.

**Quieter UI.** Pi's `Ctrl+O` collapses tool output and `"hideThinkingBlock": true` in settings hides thinking. There is no built-in setting to hide tool calls entirely.

## How the helper works

Ask for an independent look ("get an independent review of `src/foo.ts`") and the foreground model calls `loop_investigate`. Loop then:

1. Copies your working tree, including uncommitted edits, to a temporary snapshot. Symlinks, `.env*`, key files and oversized files are skipped.
2. Starts a separate Pi session on that snapshot with only `read`, `grep`, `find`, `ls`. No shell, no edits, no MCP, no Pilot, so it cannot recurse. Tool paths outside the snapshot, including `~`, are blocked by a policy hook.
3. Bounds it by time, turns (with a wrap-up request before the cap), cost and tokens.
4. Returns its findings as **claims**. Loop independently checks that each quoted piece of evidence exists at the cited file and line. That proves the quote is real, not that the claim is right.
5. Records the actual provider and model, the snapshot digest, usage, and a JSON artifact under `~/.local/state/e3d-loop/`, plus a reference in the Pi session.

The foreground prompt also tells the model when to search Brain, when to consult Pilot, and to report only test results it actually ran.

## Known gotchas

- `e3d -p` waits forever if stdin stays open (for example under a script or CI). Use `e3d -p "..." </dev/null`.
- Pi expands `~` inside its file tools. Loop's confinement rejects it; anything you add must too.
- Pi's extension packages must list Pi as a peer dependency; this repo does, with an exact dev pin for testing.
- Upgrading Pi is a deliberate act: bump the pin, run `npm test` and `e3d doctor`.

## Layout and tests

```
bin/e3d.mjs            launcher: runs pinned Pi with this package; `e3d doctor`
extensions/e3d-loop.ts Pi extension: loop_investigate, /e3d-doctor, guidance
skills/e3d-loop/       when to use Brain, Pilot and the helper
src/                   helper, snapshot, evidence, doctor, config
config/                example MCP, helper and launcher config (no secrets)
docs/                  spec, architecture, demo record
tests/                 offline: launcher-vs-Pi compatibility, safety logic
```

`npm test` runs offline with no model calls.

## Credits and license

MIT, FutCo LLC. Built on Pi by Earendil Works (MIT). Pilot, Brain and e3d-code are separate E3D projects; improvements to them belong in their own repositories.
