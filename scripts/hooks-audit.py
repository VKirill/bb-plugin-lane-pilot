#!/usr/bin/env python3
"""Audit of Claude Code hook entries on a machine against docs/guide/hooks.md.

    python3 scripts/hooks-audit.py [root=$HOME]        exit 1 when a live settings file breaks a rule

Static only: no hook is run (a PostToolUse hook may rewrite files). Archives, backups and worktrees are skipped.
"""
import json
import os
import re
import sys

SKIP = ("/node_modules/", "/.git/", "/archive/", "/backups/", "/worktrees/", ".worktrees/", "/.bb-machines/", "/.docker_home/", "/BB-service/wt/")
# A command that is one script path (with arguments) answers for its own exit code: guards refuse on purpose.
SCRIPT = re.compile(r"^(?:node |python3? |sh |bash )?[\"']?(?:/|\$\{?CLAUDE_|~/)[^;&|]*$")
FAIL_OPEN = re.compile(r"(\|\|\s*true|;\s*exit 0)['\"]?\s*$")
ABS_FILE = re.compile(r"(?<![\w$}])(/(?:home|Users)/[\w./-]+\.(?:md|sh|py|json|cjs|mjs|js))")  # guardian: allow (file paths inside a shell command, not JSON)


def findings(path: str, event: str, command: str) -> list[str]:
    out = []
    project = os.path.dirname(os.path.dirname(path))
    inline = not SCRIPT.match(command)
    if inline and not FAIL_OPEN.search(command):
        out.append("not fail-open: an inline command must end with `; exit 0` or `|| true`")
    if project != os.path.expanduser("~") and re.search(r"\bcd " + re.escape(project) + r"\b", command):
        out.append("hard-coded checkout: use \"$CLAUDE_PROJECT_DIR\" so a worktree session checks its own tree")
    if inline and event == "SessionStart" and "CLAUDE_PROJECT_DIR" not in command and re.search(r"(?<![\w/$}\"])[\w-]+/[\w./-]+\.md", command) and not command.lstrip().startswith("INPUT="):
        out.append("relative path: a start hook inherits the session's folder, anchor it to \"$CLAUDE_PROJECT_DIR\"")
    for target in ABS_FILE.findall(command):
        if not os.path.exists(target):
            out.append(f"dead target: {target} does not exist")
    return out


def audit(root: str) -> list[tuple[str, str, str, str]]:
    rows = []
    for folder, dirs, files in os.walk(root):
        full = folder + "/"
        if any(part in full for part in SKIP) or folder.count(os.sep) - root.count(os.sep) > 6:
            dirs[:] = []
            continue
        if os.path.basename(folder) != ".claude":
            continue
        for name in files:
            if not re.fullmatch(r"settings(\.local)?\.json", name):
                continue
            path = os.path.join(folder, name)
            try:
                hooks = json.load(open(path, encoding="utf-8")).get("hooks") or {}
            except (OSError, ValueError) as error:
                rows.append((path, "-", "-", f"unreadable settings file: {error}"))
                continue
            for event, groups in hooks.items():
                for group in groups:
                    for hook in group.get("hooks", []):
                        command = str(hook.get("command", ""))
                        for finding in findings(path, event, command):
                            rows.append((path, event, command[:70], finding))
    return rows


def demo() -> None:
    wiki = "[ -f wiki/index.md ] && head -60 wiki/index.md; [ -f wiki/log.md ] && tail -15 wiki/log.md"
    assert len(findings("/p/app/.claude/settings.json", "SessionStart", wiki)) == 2
    assert not findings("/p/app/.claude/settings.json", "SessionStart", 'cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null; [ -f wiki/index.md ] && head -60 wiki/index.md; exit 0')
    assert findings("/p/app/.claude/settings.json", "PostToolUse", "cd /p/app && npx tsc --noEmit || true") == ['hard-coded checkout: use "$CLAUDE_PROJECT_DIR" so a worktree session checks its own tree']
    assert not findings("/p/app/.claude/settings.json", "PreToolUse", "/p/hooks/guard-secrets.sh")
    assert findings(os.path.expanduser("~/.claude/settings.json"), "SessionStart", "cat /home/nobody/skills/x/SKILL.md")[-1].startswith("dead target")


if __name__ == "__main__":
    demo()
    found = audit(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~")))
    for path, event, command, finding in found:
        print(f"{path}\n  {event}: {command}\n  → {finding}")
    print(f"{len(found)} finding(s)")
    sys.exit(1 if found else 0)
