#!/usr/bin/env python3
"""Regenerate src/bundled-agents.json from a Claude Lane Stack revision.

Usage: bundle-lane-agents.py <claude-lane-stack checkout> <git revision>

The prompts it writes are the CLI bodies; run `node_modules/.bin/tsx scripts/sync-bundled-prompts.ts` right after: it replaces them
with the BB session prompts of src/native-agent-overlay.ts (a test keeps the two equal).
"""
import hashlib, json, re, subprocess, sys
import yaml

OUT = "src/bundled-agents.json"
TOOL_SPLIT = re.compile(r",\s*(?![^()]*\))")
OMITTED_ORDER = ["model", "effort", "permissionMode", "color", "background", "maxTurns"]


def show(repo: str, rev: str, path: str) -> bytes:
    return subprocess.check_output(["git", "-C", repo, "show", f"{rev}:{path}"])


def names(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in TOOL_SPLIT.split(value) if part.strip()]
    if isinstance(value, dict):
        return list(value.keys())
    return [str(item) for item in value]


def main(repo: str, rev: str) -> None:
    current = json.load(open(OUT))
    version = json.loads(show(repo, rev, "plugins/lane-stack/.claude-plugin/plugin.json"))["version"]
    result = {}
    for agent, old in current.items():
        file = f"agents/{agent}.md"
        raw = show(repo, rev, f"plugins/lane-stack/{file}")
        _, front, body = raw.decode().split("---\n", 2)
        meta = yaml.safe_load(front)
        sha = hashlib.sha256(raw).hexdigest()
        parts = []
        if meta.get("initialPrompt"):
            parts.append(f"## Startup instructions\n\n{meta['initialPrompt'].strip()}")
        parts.append(f"## Role\n\n{meta['description'].strip()}")
        parts.append(f"## Instructions\n\n{body.strip()}")
        parts.append(
            f"## Source\n\nImported from Claude Lane Stack `lane-stack` {version} file `{file}` "
            f"(SHA-256 {sha}, {len(raw)} bytes). Native frontmatter model, effort, and permissionMode "
            "are not applied; the BB session model and permission ceiling win."
        )
        kept = {"name", "description", "tools", "skills", "mcpServers", "initialPrompt"}
        result[agent] = {
            "displayName": old["displayName"],
            "prompt": "\n\n".join(parts),
            "tools": names(meta.get("tools")),
            "skills": names(meta.get("skills")),
            "mcpServers": names(meta.get("mcpServers")),
            "omittedNativeFields": sorted((key for key in meta if key not in kept), key=lambda key: (OMITTED_ORDER.index(key) if key in OMITTED_ORDER else len(OMITTED_ORDER), key)),
            "provenance": {
                "package": "claude-lane-stack/lane-stack",
                "version": version,
                "file": file,
                "sha256": sha,
                "bytes": len(raw),
            },
        }
    with open(OUT, "w") as out:
        out.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
