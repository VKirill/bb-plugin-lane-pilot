#!/usr/bin/env python3
"""Collect Claude Code auto-memory files into the import JSONL.

Usage: memory-collect-claude.py <dir>...

Reads every *.md under <dir> (normally ~/.claude/projects/*/memory/), skips MEMORY.md,
maps front matter `type` to the import kind vocabulary and the body to content.
origin = <machine>:<path> so a re-run is traceable and a moved file is a new source.
"""
import json
import os
import socket
import sys

TYPES = {"user", "feedback", "project", "reference", "process"}


def front_matter(text):
    """Minimal YAML front matter reader: `key: value` lines between --- fences."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    meta = {}
    for line in text[3:end].strip().splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip().strip('"').strip("'")
    return meta, text[end + 4:].lstrip("\n")


def collect(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        meta, body = front_matter(handle.read())
    content = body.strip()
    if not content:
        return None, "empty body"
    kind = meta.get("type", "")
    name = meta.get("name", os.path.splitext(os.path.basename(path))[0])
    concepts = [c for c in (name, meta.get("description", "")[:100]) if c]
    # The project folder name keeps same-named files of different projects apart: source_id is the import's identity.
    project = os.path.basename(os.path.dirname(os.path.dirname(path))) or "memory"
    record = {
        "source_id": f"{project}/{os.path.splitext(os.path.basename(path))[0]}",
        "content": content,
        "kind": kind if kind in TYPES else "reference",
        "concepts": concepts[:5],
        "created_at": int(os.path.getmtime(path) * 1000),
        "origin": f"{socket.gethostname()}:{path}",
    }
    session = meta.get("originSessionId")
    if session:
        record["origin"] += f"#{session}"
    return record, None


def main(argv):
    roots = argv[1:] or [os.path.expanduser("~/.claude/projects")]
    skipped = 0
    for root in roots:
        for dirpath, _dirs, files in os.walk(root):
            if os.path.basename(dirpath) != "memory":
                continue
            for name in sorted(files):
                if not name.endswith(".md") or name == "MEMORY.md":
                    continue
                path = os.path.join(dirpath, name)
                try:
                    record, why = collect(path)
                except OSError as exc:
                    record, why = None, str(exc)
                if record is None:
                    skipped += 1
                    print(f"skipped {why}: {path}", file=sys.stderr)
                    continue
                print(json.dumps(record, ensure_ascii=False))
    if skipped:
        print(f"skipped total: {skipped}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
