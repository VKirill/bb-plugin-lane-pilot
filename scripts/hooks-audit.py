#!/usr/bin/env python3
"""Audit of Claude Code hook entries on a machine against docs/guide/hooks.md.

    python3 scripts/hooks-audit.py [root=$HOME] [--list]   exit 1 when a live settings file breaks a rule; --list prints every entry
    python3 scripts/hooks-audit.py --host <machine-id> <home> [project-root ...] [--list]   the same on another BB machine

Static only: no hook is run (a PostToolUse hook may rewrite files). Archives, backups and worktrees are skipped.
Another machine is read through `bb file` (no shell there): its home is not walked (too large over the gateway), so name the folders
that hold projects; `bb machine list` gives the ids. Codex's `~/.codex/hooks.json` is read as well.
"""
import json
import os
import re
import subprocess
import sys

SKIP = ("/node_modules/", "/.git/", "/archive/", "/backups/", "/worktrees/", ".worktrees/", "/.bb-machines/", "/.docker_home/", "/BB-service/wt/", "/Library/", "/.Trash/", "/vendor/")
# A command that is one script path (with arguments) answers for its own exit code: guards refuse on purpose.
SCRIPT = re.compile(r"^(?:\w+=\S+ )*(?:node |python3? |sh |bash )?[\"']?(?:/|[A-Za-z]:[/\\\\]|\$\{?CLAUDE_|~/)[^;&|]*$")
FAIL_OPEN = re.compile(r"(\|\|\s*true|;\s*exit 0)['\"]?\s*$")
ABS_FILE = re.compile(r"(?<![\w$}:])(/(?:home|Users)/[\w./-]+\.(?:md|sh|py|json|cjs|mjs|js))")  # guardian: allow (file paths inside a shell command, not JSON)
HOST = ""  # a BB machine id: files are then read through `bb file`
HOME = os.path.expanduser("~")


def remote(*args: str) -> str | None:
    try:
        ran = subprocess.run(["bb", "file", *args, "--host", HOST], capture_output=True, text=True, timeout=150)
    except subprocess.TimeoutExpired:
        return None
    return ran.stdout if ran.returncode == 0 else None


def read(path: str) -> str | None:
    if HOST:
        return remote("read", path)
    try:
        return open(path, encoding="utf-8-sig").read()
    except OSError:
        return None


def exists(path: str) -> bool:
    return read(path) is not None if HOST else os.path.exists(path)


def findings(path: str, event: str, command: str) -> list[str]:
    out = []
    project = os.path.dirname(os.path.dirname(path))
    inline = not SCRIPT.match(command)
    if inline and not FAIL_OPEN.search(command):
        out.append("not fail-open: an inline command must end with `; exit 0` or `|| true`")
    if project != HOME and re.search(r"\bcd " + re.escape(project) + r"\b", command):
        out.append("hard-coded checkout: use \"$CLAUDE_PROJECT_DIR\" so a worktree session checks its own tree")
    if inline and event == "SessionStart" and "CLAUDE_PROJECT_DIR" not in command and re.search(r"(?<![\w/$}\"])[\w-]+/[\w./-]+\.md", command) and not command.lstrip().startswith("INPUT="):
        out.append("relative path: a start hook inherits the session's folder, anchor it to \"$CLAUDE_PROJECT_DIR\"")
    for target in ABS_FILE.findall(command):
        if not exists(target):
            out.append(f"dead target: {target} does not exist")
    return out


def settings_files(root: str) -> list[str]:
    if HOST:  # the two files of the root itself, then whatever the gateway's search finds below it
        found = [f"{root}/.claude/{name}" for name in ("settings.json", "settings.local.json")]
        listed = remote("paths", root, "--query", "claude/settings.json", "--files", "--limit", "200", "--exclude", "node_modules", ".git", ".venv", "dist", "build") or ""
        for line in listed.splitlines():
            rel = line.split("\t", 1)[-1].replace("\\", "/")
            if re.search(r"(^|/)\.claude/settings(\.local)?\.json$", rel) and not any(part in f"/{rel}" for part in SKIP + ("/tmp/",)):
                found.append(f"{root}/{rel}")
        return sorted(set(found))
    found = []
    for folder, dirs, files in os.walk(root):
        full = folder + "/"
        if any(part in full for part in SKIP) or folder.count(os.sep) - root.count(os.sep) > 6:
            dirs[:] = []
            continue
        if os.path.basename(folder) == ".claude":
            found += [os.path.join(folder, name) for name in files if re.fullmatch(r"settings(\.local)?\.json", name)]
    return found


def audit(roots: list[str], seen: list[str] | None = None) -> list[tuple[str, str, str, str]]:
    rows = []
    for path in [f"{HOME}/.codex/hooks.json"] + [path for root in roots for path in settings_files(root)]:
        body = read(path)
        if body is None:
            continue
        try:
            hooks = json.loads(body).get("hooks") or {}
        except ValueError as error:
            rows.append((path, "-", "-", f"unreadable settings file: {error}"))
            continue
        for event, groups in hooks.items():
            for group in groups:
                for hook in group.get("hooks", []):
                    command = str(hook.get("command", ""))
                    if seen is not None:
                        seen.append(f"{path}\t{event}\t{group.get('matcher', '')}\t{command[:90]}")
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
    assert not findings(os.path.expanduser("~/.codex/hooks.json"), "PreToolUse", "AGENT_HOOK_CLIENT=codex /p/hooks/guard_shell.py")
    assert not findings("C:/Users/x/.claude/settings.json", "SessionStart", "node C:/Users/x/.claude/hooks/sync.js")


if __name__ == "__main__":
    demo()
    args = [arg for arg in sys.argv[1:] if arg != "--list"]
    if args[:1] == ["--host"]:
        HOST, HOME, args = args[1], args[2].rstrip("/"), [arg.rstrip("/") for arg in args[2:]]
    seen: list[str] = []
    found = audit(args if HOST else [os.path.abspath(args[0] if args else HOME)], seen)
    if "--list" in sys.argv:
        print("\n".join(seen))
    for path, event, command, finding in found:
        print(f"{path}\n  {event}: {command}\n  → {finding}")
    print(f"{len(seen)} hook entr(ies) in {len({line.split(chr(9))[0] for line in seen})} file(s), {len(found)} finding(s)")
    sys.exit(1 if found else 0)
