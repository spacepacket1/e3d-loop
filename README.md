# E3D Loop

The full [Pi](https://github.com/earendil-works/pi) terminal coding agent (pinned 1.5.0), plus E3D: Pilot council, Brain memory, and an independent read-only helper model that returns evidence-checked findings. Alpha, **local-trusted execution** (no sandbox).

Spec: [docs/e3d-loop-spec.md](docs/e3d-loop-spec.md). Design: [docs/architecture.md](docs/architecture.md).

## Install
```sh
git clone git@github.com:spacepacket1/e3d-loop.git && cd e3d-loop
npm install && npm link          # provides the `e3d` command (or run node bin/e3d.mjs)
e3d doctor                       # check setup (add --connect to test MCP servers)
```
Credentials: run `e3d` then `/login`, or set a provider key in your environment as Pi documents.

## Use
`e3d` behaves like `pi` (all flags, `-p`, `--mode rpc`, `-c`, `-r`, `mcp`, `install`, ...). Extras: tool `loop_investigate` (model calls it, or ask "get an independent review of X"), `/e3d-doctor`, and short guidance on when to use Brain and Pilot.

## Configure (no secrets in files)
- MCP: copy entries from `config/mcp.example.json` into `~/.pi/agent/mcp.json`, or `pi mcp add`.
- Helper model: copy `config/e3d-loop.example.json` to `~/.config/e3d-loop/config.json`, set `helper.model` to a different `provider/model` than your foreground model.

## Test
`npm test` (offline; checks launcher transparency vs bare Pi, snapshot, evidence checks, bounds, recursion guard).
