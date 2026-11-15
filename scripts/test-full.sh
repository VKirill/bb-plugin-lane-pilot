#!/usr/bin/env bash
# The full vitest run once per code state. On green it writes the same receipt bb-plugin-push checks, keyed by the
# tree of HEAD and the node version, so the deploy does not run the same ~3-minute suite again. The receipt describes
# exactly the committed code, so only a full run (no positional args — those always execute) on a clean tree may
# reuse or write one. Tracked edits and untracked files the suite can read count as dirty; untracked evidence
# (.agents/, .bb/, docs) does not. The tree must be clean at the START as well as at the end, with the same HEAD and
# tree: a run that began dirty tested other code than the commit, even if the edits are gone by the end, so its green
# is a diagnostic and attests nothing. A git read that fails is never read as «clean». An edit-and-revert inside a
# run that started and ended clean is not detectable and is not claimed to be.
set -uo pipefail
cd "$(dirname "$0")/.."
receipts="${LP_TEST_RECEIPTS:-$HOME/.lane-pilot/test-receipts}"

# Untracked files that can feed the suite: the vitest include glob, the code trees tests import, runner configs.
# Hidden dirs (.agents evidence, .bb artifacts, .github) and docs are never suite input. `ls-files --directory`
# collapses a wholly untracked dir to `dir/` — its contents are invisible, so any non-hidden dir entry counts dirty.
# 0 clean, 1 dirty, 2 git could not be read (never taken for clean).
tree_state() {
  local tracked untracked file
  tracked="$(git status --porcelain --untracked-files=no)" || return 2
  [ -z "$tracked" ] || return 1
  untracked="$(git ls-files --others --exclude-standard --directory)" || return 2
  while IFS= read -r file; do
    case "$file" in
      ""|.*|docs/|*.md|*.markdown|*.txt|*.log|*.jsonl) ;;
      */) return 1 ;;
      src/*|packages/*|tests/*|scripts/*|e2e/*|*.test.*|*.spec.*|*.json|vitest.*config.*|vite.config.*|vitest.workspace.*|package.json|package-lock.json|pnpm-lock.yaml|yarn.lock|bun.lockb|tsconfig*.json) return 1 ;;
    esac
  done <<<"$untracked"
  return 0
}

full=1; [ $# -gt 0 ] && full=0
start_clean=0
if [ "$full" = 1 ]; then
  # A full run attests one code state; unreadable git state attests nothing, so it stops before running.
  start_head="$(git rev-parse HEAD)" && start_tree="$(git rev-parse 'HEAD^{tree}')" && [ -n "$start_head" ] && [ -n "$start_tree" ] \
    || { echo "test-full: cannot read HEAD and its tree; a full run here would attest nothing" >&2; exit 1; }
  tree_state; state=$?
  [ "$state" -ne 2 ] || { echo "test-full: cannot read git status; a full run here would attest nothing" >&2; exit 1; }
  [ "$state" -eq 0 ] && start_clean=1
  node_version="$(node -v)" || { echo "test-full: cannot read the node version" >&2; exit 1; }
  key="$start_tree-$node_version"
  if [ "$start_clean" = 1 ] && [ -f "$receipts/$key" ]; then
    echo "test-full: this code already passed the full suite ($(head -1 "$receipts/$key"))"; exit 0
  fi
fi
log="$(mktemp "${TMPDIR:-/tmp}/lp-test-full.XXXXXX")" || { echo "test-full: mktemp failed" >&2; exit 1; }
trap 'rm -f "$log"' EXIT
NO_COLOR=1 npx vitest run "$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}") # captured here: PIPESTATUS is unreliable inside the if-condition list
if [ "${statuses[0]}" -eq 0 ] && [ "${statuses[1]}" -eq 0 ]; then
  [ "$full" = 1 ] || exit 0
  if [ "$start_clean" != 1 ]; then
    echo "test-full: the run started on a dirty tree, so it tested other code than HEAD; green, but no receipt written"; exit 0
  fi
  end_head="$(git rev-parse HEAD)" && end_tree="$(git rev-parse 'HEAD^{tree}')" \
    || { echo "test-full: cannot read HEAD after the run; no receipt written" >&2; exit 1; }
  tree_state; state=$?
  [ "$state" -ne 2 ] || { echo "test-full: cannot read git status after the run; no receipt written" >&2; exit 1; }
  if [ "$state" -eq 0 ] && [ "$end_head" = "$start_head" ] && [ "$end_tree" = "$start_tree" ]; then
    mkdir -p "$receipts" || { echo "test-full: cannot create $receipts" >&2; exit 1; }
    if ! printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$(grep -E 'Tests ' "$log" | tail -1 | sed 's/^ *//')" > "$receipts/$key"; then
      echo "test-full: receipt write failed for $key" >&2; exit 1
    fi
    echo "test-full: receipt written for $key"
  else
    echo "test-full: tree not clean or HEAD moved during the run; no receipt written"
  fi
  exit 0
fi
exit 1
