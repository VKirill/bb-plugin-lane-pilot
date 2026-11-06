#!/usr/bin/env bash
# Collect BB memory into the import JSONL: {source_id, content, kind?, concepts?, created_at?, origin}.
# One `bb memory get` per catalog entry; content is name + details (summary is the short form of details).
set -euo pipefail

# `--scope all` stops at 100; project and global each stay under it (2026-11-06: 83 + 68). A scope at the cap is refused, not cut.
for scope in project global; do
  listed=$(bb memory catalog --scope "$scope" --limit 100 --json)
  [ "$(jq '.total' <<<"$listed")" -le 100 ] || { echo "memory-collect-bb: scope $scope has over 100 memories, the catalog cannot list them all" >&2; exit 1; }
  jq -r '.memories[]?.id // empty' <<<"$listed"
done | sort -u | while IFS= read -r id; do
  bb memory get "$id" --json | jq -c --arg id "$id" '
    .memory // empty |
    select(.id == $id) |
    {
      source_id: .id,
      content: ((.name // "") + "\n" + (.details // .summary // "")),
      kind: .kind,
      concepts: (.tags // []),
      created_at: .createdAt,
      origin: ("bb:" + (.projectId // "global") + ":" + .id)
    }'
done
