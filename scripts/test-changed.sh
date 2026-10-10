#!/usr/bin/env bash
# Everyday check: only the tests that import (directly or through the module graph) a file you changed.
# Uncommitted edits count against HEAD; with a clean tree the commits of this branch count against main.
# `npm run test:changed -- <ref>` picks another base; other flags go to vitest. The full suite (npm test, scripts/test-full.sh)
# stays the gate for deploy: this script writes no receipt.
set -uo pipefail
cd "$(dirname "$0")/.."
base="${1:-}"
if [ -n "$base" ] && [[ "$base" != -* ]]; then shift; else
  if [ -n "$(git status --porcelain)" ]; then base=HEAD
  elif git rev-parse --verify -q main >/dev/null; then base="$(git merge-base HEAD main)"
  else base=HEAD; fi
fi
echo "test:changed: tests related to changes since $(git rev-parse --short "$base")"
exec npx vitest run --changed "$base" --passWithNoTests "$@"
