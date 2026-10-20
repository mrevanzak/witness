#!/usr/bin/env bash
# Builds a standalone git repo for verifier tests from this example:
#   main                    the base app (empty titles are accepted)
#   feat/empty-title        correct "empty title validation" (client + server)
#   feat/empty-title-broken deliberately broken implementation
# Usage: make-fixture.sh [dest]   (default: <repo>/runs/fixtures/todo-app)
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$SRC/../../runs/fixtures/todo-app}"
rm -rf "$DEST" && mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
cp -R "$SRC"/{package.json,witness.yaml,server.mjs,public} "$DEST/"
cd "$DEST"
g() { git -c user.name=fixture -c user.email=fixture@example.com -c commit.gpgsign=false "$@"; }
g init -q -b main
g add -A && g commit -qm "Todo app"
g checkout -qb feat/empty-title
cp -R "$SRC/variants/good/." .
g add -A && g commit -qm "Validate empty todo titles" -m "Adding a todo with an empty or whitespace-only title shows 'Title is required' under the input and does not add the todo."
g checkout -q main && g checkout -qb feat/empty-title-broken
cp -R "$SRC/variants/broken/." .
g add -A && g commit -qm "Validate empty todo titles" -m "Adding a todo with an empty or whitespace-only title shows 'Title is required' under the input and does not add the todo."
g checkout -q main
echo "$DEST"
