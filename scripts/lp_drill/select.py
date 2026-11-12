"""Which scenarios a deploy gate runs: changed files mapped onto the live set."""
from __future__ import annotations

import fnmatch
import json
import os
import re
import time
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.hub import run

# Which changed files a live scenario reads. A path no live scenario reads (NOT_LIVE) starts none; a shared one (FOUNDATION, and anything
# outside src/ and packages/ that is not NOT_LIVE) starts every one; else parallel3 runs unless the path is in a room it does not pass
# through, and the narrow scenarios run only for their own code. Unsure means run: a wrong row costs one more drill, not a missed one,
# and every live scenario runs at least once a day (LIVE_MAX_AGE_SEC) whatever changed.
LIVE = ("memory_paths", "helper_providers", "parallel3")
LIVE_MAX_AGE_SEC = 24 * 3600
NOT_LIVE = ["docs/**", "tests/**", ".agents/**", ".bb/**", "**/*.md", "src/**/ui/**", "src/**/*.tsx", "src/rooms/sma-map/**",
            "src/rooms/world/**", "src/rooms/ui-shell/**", "packages/i18n/**", "packages/ui-kit/**", "packages/pixel-world/**",
            "packages/world-sim/**", "scripts/**", "vitest*", "tsconfig*", ".gitignore", ".gitnexus/**", "CLAUDE.md", "AGENTS.md"]
FOUNDATION = ["scripts/lp-drill.py", "scripts/lp_drill/**", "scripts/lp-drill.sh", "package-lock.json", "src/rooms/core/**", "src/rooms/storage/**", "src/rooms/contracts/**",
              "src/rooms/settings/**", "packages/contracts/**", "packages/kit/**", "packages/settings-catalog/**", "packages/host-calls/**", "packages/models/**"]
# Rooms a writer task's road (dispatch, writer, checks, merge, acceptance) does not pass through.
PARALLEL3_SKIP = [f"src/rooms/{room}/**" for room in ("phase", "council", "cockpit", "night", "night-graphs", "hypotheses", "bench", "forge", "money",
                  "forecast", "coverage", "docs", "backlog", "anamnesis", "twins", "outbound", "owner-presence", "memory-eval", "design-eval", "deferral", "checkers")]
SCENARIO_CODE = {
    "episodes": ["src/rooms/errands/**", "src/rooms/qa/server/errand*", "src/rooms/workflow/server/workflow.ts", "packages/harness-core/src/trajectory.ts"],
    "helper_providers": ["src/rooms/native-agent/**", "src/rooms/runs/server/run-routing*", "src/rooms/stability/server/probes.ts", "src/rooms/tools/server/cli*",
                         "src/rooms/critique/pm-read.ts", "packages/thread-observe/**"],
    "memory_paths": ["src/rooms/memory/**", "src/rooms/memory-probe/**", "src/rooms/memory-tiers/**", "packages/memory-core/**", "src/rooms/native-agent/**",
                     "src/rooms/writer/server/writer-task.ts", "src/rooms/writer/server/writer-knowledge.ts", "src/rooms/critique/**", "src/rooms/council/server/**"],
}
def glob_match(path: str, pattern: str) -> bool:
    """owns_paths-style globs: `**` spans folders, `*` stays inside one; a pattern without a slash matches the file name at any depth."""
    if "/" not in pattern:
        return fnmatch.fnmatchcase(path.rsplit("/", 1)[-1], pattern)
    regex = re.escape(pattern).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
    return re.fullmatch(regex, path) is not None


def live_reads(name: str, path: str) -> bool:
    """Does the live scenario `name` read the changed file `path`?"""
    if any(glob_match(path, pattern) for pattern in FOUNDATION):
        return True
    if any(glob_match(path, pattern) for pattern in NOT_LIVE):
        return False
    if not path.startswith(("src/", "packages/")):
        return True
    if name == "parallel3":
        return not any(glob_match(path, pattern) for pattern in PARALLEL3_SKIP)
    return any(glob_match(path, pattern) for pattern in SCENARIO_CODE[name])


def changed_since(commit: str, head: str = "HEAD") -> list[str] | None:
    """Files changed from `commit` to `head` in this checkout; None when the commit is not in its history. package.json and its lock
    whose only change is the plugin's own version do not count: every deploy bumps it (a dependency's version line still counts)."""
    rc, _, _ = run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", commit, head], timeout=30)
    if rc != 0:
        return None
    rc, out, _ = run(["git", "-C", str(ROOT), "diff", "--name-only", commit, head], timeout=60)
    if rc != 0:
        return None
    files = [line for line in out.splitlines() if line]
    versions = set()
    for ref in (commit, head):
        _, text, _ = run(["git", "-C", str(ROOT), "show", f"{ref}:package.json"], timeout=30)
        try:
            versions.add(json.loads(text).get("version"))
        except ValueError:
            pass
    for name in ("package.json", "package-lock.json"):
        if name not in files:
            continue
        _, diff, _ = run(["git", "-C", str(ROOT), "diff", "-U0", commit, head, "--", name], timeout=30)
        lines = [line for line in diff.splitlines() if line[:1] in "+-" and not line.startswith(("+++", "---"))]
        own = [re.match(r'^[+-]\s*"version":\s*"([^"]+)",?\s*$', line) for line in lines]
        if all(match and match.group(1) in versions for match in own):
            files.remove(name)
    return files


def last_passed(name: str, receipt_dir: Path) -> tuple[str, float] | None:
    """The commit and finish time of the newest receipt here in which `name` ran and passed."""
    for path in sorted(receipt_dir.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or not data.get("commit"):
            continue
        if any(row.get("name") == name and row.get("result") == "pass" for row in data.get("scenarios") or []):
            return data["commit"], (data.get("finishedAt") or 0) / 1000
    return None


def select_quick(receipt_dir: Path, now: float | None = None) -> tuple[list[str], dict[str, str]]:
    """The --quick scenarios this deploy needs, and why each live one left out is left out."""
    now = time.time() if now is None else now
    names, skipped = [], {}
    for name in QUICK:
        if name not in LIVE:
            names.append(name)
            continue
        # The deploy keeps to the checks without models (about 35 s): the live ones run in the nightly drill (LP_DRILL_SELECT=0, cron on
        # OVH), which reports a red run to the thread like a deploy does. Of 19 red deploy drills to 2026-11-12, 14 were the hub or a provider
        # (HTTP 502, activate timeout, quota), not the change (owner 2026-11-12: a deploy in one or two minutes). LP_DRILL_LIVE=1 selects as before.
        if os.environ.get("LP_DRILL_LIVE") != "1":
            skipped[name] = "live: runs in the nightly drill (LP_DRILL_LIVE=1 runs it here)"
            continue
        last = last_passed(name, receipt_dir)
        if not last or now - last[1] > LIVE_MAX_AGE_SEC:
            names.append(name)
            continue
        files = changed_since(last[0])
        reads = [path for path in files if live_reads(name, path)] if files is not None else None
        if reads is None or reads:
            names.append(name)
            continue
        skipped[name] = f"passed at {last[0][:12]} {round((now - last[1]) / 3600, 1)} h ago; none of the {len(files)} file(s) changed since is its code"
    return names, skipped
