#!/usr/bin/env bash
# Collect BB memory into the import JSONL: {source_id, content, kind?, concepts?, created_at?, origin}.
# One `bb memory get` per catalog entry; content is name + details (summary is the short form of details).
set -euo pipefail

bb memory catalog --scope all --limit 100 --json | jq -r '.memories[]?.id // empty' | while IFS= read -r id; do
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
