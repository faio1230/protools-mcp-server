#!/bin/zsh
set -eu
cd "${0:A:h}/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node_bin="$(command -v node)"
proto_path="${PTSL_PROTO_PATH:-$PWD/ptsl_sdk/PTSL.2024.10.0.proto}"
[[ -f "$proto_path" && -f dist/index.js ]] || { print -u2 'Build the server and configure the Avid SDK first.'; exit 1; }
codex mcp add protools --env "PTSL_PROTO_PATH=$proto_path" --env ALLOW_WRITES=export,session,print --env PTSL_EXPORT_ONLY=1 -- "$node_bin" "$PWD/dist/index.js"
