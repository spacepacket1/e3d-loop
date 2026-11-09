#!/usr/bin/env bash
# Example launcher that loads provider keys from files at launch only. Keep your copy OUTSIDE the repo
# (e.g. ~/.config/e3d-loop/run.sh), chmod 700, and never commit keys. Adjust the paths to your own key files.
# A key file may be a shell file (`export ANTHROPIC_API_KEY=...`) or contain just the raw key.
set -euo pipefail
K="$HOME/.config/e3d-keys"
load() { # file ENVNAME
  [[ -f "$1" ]] || return 0
  if grep -qE '^(export )?[A-Z_]+=' "$1"; then set -a; . "$1"; set +a; else export "$2=$(tr -d '[:space:]' < "$1")"; fi
}
load "$K/anthropic" ANTHROPIC_API_KEY
load "$K/openai" OPENAI_API_KEY
exec node "$HOME/path/to/e3d-loop/bin/e3d.mjs" "$@"
