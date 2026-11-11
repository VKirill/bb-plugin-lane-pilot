"""The task specs the drill writes: one note per writer task, each with its own check."""
from __future__ import annotations

import shlex
from pathlib import Path

from lp_drill.env import STAMP

def task(task_id: str, title: str, outputs: list[str], objective: str, acceptance: list[str], cwd: str, risk: str = "high", read_first: list[str] | None = None, verification: list[dict] | None = None) -> dict:
    return {
        # The task standard (the Tasks board). One area per task: tasks of one area run one at a time, and the drills run side by side.
        "schema_version": 2, "id": task_id, "title": title, "display_title": f"Учение: {title}"[:60], "kind": "chore", "area": f"drill:{task_id}", "risk": risk, "lane": "writer", "project_cwd": cwd,
        "read_first": read_first or [], "interfaces": [], "invariants": ["Touch no file except the ones in expected_outputs."],
        "out_of_scope": ["Every other file of the project."], "expected_outputs": outputs, "owns_paths": outputs,
        "never_touch": ["src/**", "tests/**", "package.json"], "depends_on": [], "objective": objective, "acceptance": acceptance,
        "verify": "none" if not verification else "smoke", "verification": verification or [],
    }


def note_task(task_id: str, path: str, text: str, cwd: str, before: str = "") -> dict:
    """A task that writes one two-line note; `before` is an instruction to do first (a sleep that holds the writer in its attempt)."""
    lead = f"{before} Then create" if before else "Create"
    return task(task_id, f"{text}: one note", [path], f"{lead} the file {path} with exactly two lines. Line 1: `# {text}`. Line 2: `ok: {text}`. Nothing else.",
                [f"{path} exists, its first line is `# {text}` and its second line is `ok: {text}`."], cwd,
                # A real check (SMA coverage: the drill's verification stage must not be vacuous): red on the base, green after the writer.
                verification=[{"command": f"test \"$(sed -n 1p {shlex.quote(path)})\" = {shlex.quote('# ' + text)} && test \"$(sed -n 2p {shlex.quote(path)})\" = {shlex.quote('ok: ' + text)}", "cwd": cwd}])
def tasks_parallel3(cwd: str) -> list[dict]:
    # Each task carries a real check, red on the base and green only with the writer's file: the quick drill that gates a deploy ran
    # these with an empty verification, so its «verification passed» proved nothing about running a project's checks (audit 2026-10-28).
    def check(letter: str) -> list[dict]:
        path = f"notes/drill/{STAMP}-{letter}.md"
        return [{"command": f"test \"$(sed -n 1p {shlex.quote(path)})\" = {shlex.quote(f'# Drill {STAMP} {letter}')} && test \"$(sed -n 2p {shlex.quote(path)})\" = {shlex.quote(f'ok: {letter}')}", "cwd": cwd}]
    return [task(f"drill-{STAMP}-{letter}", f"Drill {STAMP} {letter}: one note", [f"notes/drill/{STAMP}-{letter}.md"],
                 f"Create the file notes/drill/{STAMP}-{letter}.md with exactly two lines. Line 1: `# Drill {STAMP} {letter}`. Line 2: `ok: {letter}`. Nothing else.",
                 [f"notes/drill/{STAMP}-{letter}.md exists, its first line is `# Drill {STAMP} {letter}` and its second line is `ok: {letter}`."], cwd,
                 verification=check(letter))
            for letter in "abc"]


def conflict_path() -> str:
    return f"notes/drill/{STAMP}-conflict.md"


def tasks_conflict(cwd: str) -> list[dict]:
    rel = conflict_path()
    return [task(f"drill-{STAMP}-conflict-{side}", f"Drill {STAMP}: line 2 becomes {side}", [rel],
                 f"In {rel} replace line 2 (`line: base` or whatever it says now) with `line: {side}`. Keep lines 1 and 3 as they are. Nothing else.",
                 [f"Line 2 of {rel} is `line: {side}`, line 1 is `# Drill {STAMP} conflict` and line 3 is `end`."], cwd, read_first=[rel]) for side in ("X", "Y")]


def task_moved(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-moved", f"notes/drill/{STAMP}-moved.md", f"Drill {STAMP} moved", cwd, before="First run `sleep 45` with Bash and wait for it.")


def task_limit(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-limit", f"notes/drill/{STAMP}-limit.md", f"Drill {STAMP} limit", cwd)


def task_reload(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-reload", f"notes/drill/{STAMP}-reload.md", f"Drill {STAMP} reload", cwd, before="First run `sleep 60` with Bash and wait for it.")


def task_nogit(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-nogit", f"drill-{STAMP}-nogit.md", f"Drill {STAMP} nogit", cwd) | {"risk": "low"}


NOGIT_REPO = "repo-a"


def task_nogit_repo(cwd: str) -> dict:
    # Written from the folder without git, as the BB-сервис PM writes a plugin task.
    spec = note_task(f"drill-{STAMP}-nogit-repo", f"{NOGIT_REPO}/notes/drill-{STAMP}.md", f"Drill {STAMP} nogit repo", cwd) | {"risk": "low"}
    # The check runs inside the repository, as a plugin task's does: a check with cwd in the folder without git keeps the task out of the
    # repository (it cannot run in the repository's worktree), and Lane Pilot sends such a task back (2026-10-27: the task ran in the live folder).
    text, inside = f"Drill {STAMP} nogit repo", f"notes/drill-{STAMP}.md"
    spec["verification"] = [{"command": f"test \"$(sed -n 1p {shlex.quote(inside)})\" = {shlex.quote('# ' + text)} && test \"$(sed -n 2p {shlex.quote(inside)})\" = {shlex.quote('ok: ' + text)}",
                             "cwd": str(Path(cwd) / NOGIT_REPO)}]
    return spec
MEMORY_ANCHOR = "lp-probe/memory"


def task_memory(cwd: str) -> dict:
    """The task whose writer brief must carry the probe's note (it names the folder), core convention and rule. Cancelled once its thread exists."""
    rel = f"{MEMORY_ANCHOR}/{STAMP}.md"
    return note_task(f"drill-{STAMP}-memory", rel, f"Drill {STAMP} memory", cwd) | {"risk": "low"}
def task_provider(cwd: str) -> dict:
    return note_task(f"drill-{STAMP}-provider", f"notes/drill/{STAMP}-provider.md", f"Drill {STAMP} provider", cwd)
def tasks_no_code_exit(cwd: str, series: bool = False) -> list[dict]:
    """The no-code tasks. The owner's question always; under --series (SMA m_sd_answer) also answer-only research and code work
    told to change nothing."""
    path = f"drills/needs-human-{STAMP}.md"
    question = task(f"drill-human-{STAMP}", "a question for the owner", [path],
                    f"Do not create or change any file. Your whole final report is one line: `NEEDS_HUMAN: which colour should {path} use?`",
                    [f"{path} exists"], cwd)
    if not series:
        return [question]
    answer = task(f"drill-answer-{STAMP}", "one question, no files", ["the answer in the writer's report"],
                  "Answer one question in your report and change no file: which stage closes a task that only asks? Say it in one line.",
                  ["the report answers the question"], cwd)
    answer["kind"] = "research"
    code = task(f"drill-noedit-{STAMP}", "a fix told to change nothing", [f"drills/noedit-{STAMP}.md"],
                f"The contract's output is drills/noedit-{STAMP}.md, but change nothing: create or edit no file. Report the task done anyway.",
                [f"drills/noedit-{STAMP}.md exists"], cwd)
    code["kind"] = "fix"
    return [question, answer, code]
