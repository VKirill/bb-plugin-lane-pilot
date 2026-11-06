#!/usr/bin/env bash
# Give a worktree its own node_modules: every entry links to the main checkout's
# node_modules, except @lane-pilot/*, which links to this worktree's packages/,
# so tsc, vitest and the build see the branch's packages, not main's.
# Usage: scripts/worktree-modules.sh <worktree> [main checkout]
set -euo pipefail
wt=$(cd "$1" && pwd)
main=$(cd "${2:-$(dirname "$0")/..}" && pwd)
[ "$wt" = "$main" ] && { echo "refusing to touch the main checkout" >&2; exit 1; }
rm -rf "$wt/node_modules"
mkdir -p "$wt/node_modules/@lane-pilot"
for e in "$main"/node_modules/* "$main"/node_modules/.bin "$main"/node_modules/.package-lock.json; do
  [ -e "$e" ] || continue
  n=$(basename "$e")
  [ "$n" = "@lane-pilot" ] || ln -s "$e" "$wt/node_modules/$n"
done
for p in "$wt"/packages/*/; do
  name=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'].split('/')[-1])" "$p/package.json")
  ln -s "../../packages/$(basename "$p")" "$wt/node_modules/@lane-pilot/$name"
done
echo "node_modules ready in $wt"
