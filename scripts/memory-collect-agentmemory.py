#!/usr/bin/env python3
"""Collect the agentmemory archive export into the import JSONL.

Usage: memory-collect-agentmemory.py <dir>

Reads the export files under <dir> (the /agentmemory/export or obsidian-export dump:
*.json arrays, *.jsonl lines, *.md notes). Only observations with a text body become
records; everything else is reported on stderr as `skipped <reason>: <file>`.
"""
import json
import os
import sys

TEXT_KEYS = ("content", "text", "observation", "summary", "message", "body")
ID_KEYS = ("id", "uuid", "_id", "slug", "name")
DATE_KEYS = ("createdAt", "created_at", "timestamp", "recordedAt", "date")


def text_of(record):
    for key in TEXT_KEYS:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def source_id_of(record, fallback):
    for key in ID_KEYS:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)):
            return str(value)
    return fallback


def date_of(record):
    for key in DATE_KEYS:
        value = record.get(key)
        if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip()):
            return value
    return None


def iter_records(path):
    """Yield (record, where) from one export file; `where` locates the line for skip reports."""
    if path.endswith(".jsonl"):
        with open(path, encoding="utf-8", errors="replace") as handle:
            for number, line in enumerate(handle, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line), f"{path}:{number}"
                except json.JSONDecodeError:
                    yield None, f"{path}:{number} bad json"
    elif path.endswith(".json"):
        with open(path, encoding="utf-8", errors="replace") as handle:
            try:
                data = json.load(handle)
            except json.JSONDecodeError as exc:
                yield None, f"{path} bad json: {exc}"
                return
        items = data if isinstance(data, list) else [data]
        # An export envelope like {"observations": [...]} unwraps one level.
        if len(items) == 1 and isinstance(items[0], dict):
            for key in ("observations", "memories", "records", "items", "data"):
                if isinstance(items[0].get(key), list):
                    items = items[0][key]
                    break
        for index, item in enumerate(items):
            yield item, f"{path}:{index + 1}"
    elif path.endswith(".md"):
        with open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read().strip()
        if text:
            yield {"content": text, "name": os.path.splitext(os.path.basename(path))[0]}, path


def main(argv):
    if len(argv) != 2:
        print("usage: memory-collect-agentmemory.py <dir>", file=sys.stderr)
        return 2
    root = argv[1]
    skipped = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            path = os.path.join(dirpath, name)
            if not name.endswith((".json", ".jsonl", ".md")):
                continue
            for record, where in iter_records(path):
                if record is None:
                    skipped += 1
                    print(f"skipped {where}", file=sys.stderr)
                    continue
                if not isinstance(record, dict):
                    skipped += 1
                    print(f"skipped not-an-observation: {where}", file=sys.stderr)
                    continue
                text = text_of(record)
                if not text:
                    skipped += 1
                    print(f"skipped no-text-body: {where}", file=sys.stderr)
                    continue
                out = {"source_id": source_id_of(record, os.path.basename(path)), "content": text}
                kind = record.get("kind") or record.get("type")
                if isinstance(kind, str) and kind.strip():
                    out["kind"] = kind.strip()
                created = date_of(record)
                if created is not None:
                    out["created_at"] = created
                print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
