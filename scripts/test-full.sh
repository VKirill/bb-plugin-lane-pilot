#!/usr/bin/env bash
# The full vitest run once per code state. On green it writes the same receipt bb-plugin-push checks, keyed by the
# tree of HEAD and the node version, so the deploy does not run the same ~3-minute suite again. A dirty tree (tracked
# changes) runs the tests but writes no receipt: the receipt must describe exactly the committed code.
set -uo pipefail
cd "$(dirname "$0")/.."
receipts="${LP_TEST_RECEIPTS:-$HOME/.lane-pilot/test-receipts}"
key="$(git rev-parse 'HEAD^{tree}')-$(node -v)"
if [ -z "$(git status --porcelain --untracked-files=no)" ] && [ -f "$receipts/$key" ]; then
  echo "test-full: this code already passed the full suite ($(head -1 "$receipts/$key"))"; exit 0
fi
log="$(mktemp -t lp-test-full)"
trap 'rm -f "$log"' EXIT
if NO_COLOR=1 npx vitest run "$@" 2>&1 | tee "$log"; [ "${PIPESTATUS[0]}" -eq 0 ]; then
  if [ $# -eq 0 ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
    mkdir -p "$receipts"
    printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$(grep -E 'Tests ' "$log" | tail -1 | sed 's/^ *//')" > "$receipts/$key"
    echo "test-full: receipt written for $key"
  fi
  exit 0
fi
exit 1
