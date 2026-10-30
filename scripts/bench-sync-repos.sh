#!/usr/bin/env bash
# Clone or update the git repositories a bench set names, into $BENCH_REPOS_ROOT, from each repo's origin.
# Does not copy a worktree from another machine. Paths: one absolute checkout per line, from the files
# given as arguments or from stdin. A path that is not a git checkout with `origin`, and whose destination
# does not already have one, is printed as `no remote:` and the script exits 2 after the rest are synced.
# Usage: BENCH_REPOS_ROOT=$HOME/lp-bench/repos scripts/bench-sync-repos.sh paths.txt
set -euo pipefail
ROOT="${BENCH_REPOS_ROOT:-$HOME/lp-bench/repos}"
mkdir -p "$ROOT"
missing=()
declare -A seen=()

sync_one() {
  local path="$1"
  path="${path%%$'\r'}"
  [ -z "$path" ] && return 0
  [[ "$path" == \#* ]] && return 0
  local leaf dest remote=""
  leaf="$(basename "$path")"
  [ -n "${seen[$leaf]:-}" ] && return 0
  seen[$leaf]=1
  dest="$ROOT/$leaf"
  if [ -d "$path/.git" ] || [ -f "$path/.git" ]; then
    remote="$(git -C "$path" remote get-url origin 2>/dev/null || true)"
  fi
  if [ -z "$remote" ] && [ -d "$dest/.git" ]; then
    remote="$(git -C "$dest" remote get-url origin 2>/dev/null || true)"
  fi
  if [ -z "$remote" ]; then
    echo "no remote: $path"
    missing+=("$path")
    return 0
  fi
  if [ -d "$dest/.git" ]; then
    git -C "$dest" fetch -q --prune origin
    git -C "$dest" pull -q --ff-only || true
    echo "updated $dest"
  else
    git clone -q --origin origin "$remote" "$dest"
    echo "cloned $dest"
  fi
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    while IFS= read -r line || [ -n "$line" ]; do sync_one "$line"; done < "$file"
  done
else
  while IFS= read -r line || [ -n "$line" ]; do sync_one "$line"; done
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "NO_REMOTE ${#missing[@]}"
  exit 2
fi
