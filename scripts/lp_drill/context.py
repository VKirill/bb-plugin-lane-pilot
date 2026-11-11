"""Context: one PM and one run in a sandbox project — dispatch, rows, waiting, finishing."""
from __future__ import annotations

import json
import time

from lp_drill.env import OPEN_STATES, POLL_SEC, SANDBOX, TERMINAL, TIMEOUT_MIN
from lp_drill.hub import bb, hubsql, log, thread_field, thread_status
from lp_drill.report import latest_states

class Context:
    """One PM and one run in a sandbox project."""

    def __init__(self, spec: dict, tmp: Path):
        self.project, self.environment, self.cwd = spec["project"], spec["environment"], spec["cwd"]
        self.tmp = tmp
        self.source = self.pm = self.run_id = ""
        self.dispatches: dict[str, str] = {}
        # The report of `memory-probe --keep`, planted before the PM started (scenario memory_paths); None when that scenario is not run.
        self.memory_probe: dict | None = None

    def start(self) -> None:
        rc, out, err = bb("thread", "spawn", "--project", self.project, "--environment", self.environment, "--provider", "codex", "--model", "gpt-6-luna",
                          "--prompt", "Reply with OK only.", "--json")
        self.source = thread_field(out, "id") if rc == 0 else ""
        if not self.source:
            raise RuntimeError(f"source thread did not start: {err.strip()[:300] or out[:300]}")
        log(f"source thread {self.source}")
        for _ in range(36):
            if thread_status(self.source) == "idle":
                break
            time.sleep(5)
        else:
            raise RuntimeError("source thread did not settle")
        self.free_sandbox()
        rc, out, err = bb("lane-pilot", "activate", self.project, self.source)
        self.pm, self.run_id = thread_field(out, "threadId"), thread_field(out, "runId")
        if rc != 0 or not self.pm or not self.run_id:
            raise RuntimeError(f"activate failed: {(err.strip() or out)[:300]}")
        log(f"PM {self.pm}, run {self.run_id} ({self.project})")

    def free_sandbox(self) -> None:
        """An earlier drill that died (a full disk, a killed deploy) can leave an open run in the sandbox project, which holds the
        project's activation: cancel its open attempts and finish it, so this drill can start its PM (live 2026-10-27)."""
        try:
            left = hubsql(f"select id from lane_pilot_run where project_id='{self.project}' and closed_at is null and state in ('pending','running','blocked');")
        except RuntimeError as cause:
            log(f"sandbox check skipped: {cause}")
            return
        for row in left:
            run = row["id"]
            for attempt in hubsql(f"select id from lane_pilot_attempt where run_id='{run}' and state in ({','.join(repr(s) for s in OPEN_STATES)});"):
                log(f"leftover run {run}: cancelling {attempt['id']}")
                bb("lane-pilot", "cancel", attempt["id"])
        for row in left:
            rc, out, err = bb("lane-pilot", "finish", self.project, row["id"])
            log(f"leftover run {row['id']}: finish {'ok' if rc == 0 else (out + err).strip()[:200]}")

    def dispatch(self, spec: dict) -> bool:
        rc, out, err = bb("lane-pilot", "dispatch-bb", self.project, self.pm, json.dumps(spec))
        self.dispatches[spec["id"]] = (out + err).strip()[:600]
        if rc != 0:
            log(f"dispatch of {spec['id']} failed: {self.dispatches[spec['id']][:200]}")
        return rc == 0

    def rows(self, ids: list[str]) -> list[dict]:
        quoted = ",".join("'" + i.replace("'", "''") + "'" for i in ids)
        return hubsql(f"select id, task_id, state, reason, thread_id, workspace_path, environment_id, holder_thread_id, created_at from lane_pilot_attempt where run_id='{self.run_id}' and task_id in ({quoted});")

    def wait_ended(self, ids: list[str], timeout_min: int = TIMEOUT_MIN) -> list[dict]:
        """Rows once every task's latest attempt is accepted, blocked or canceled, twice in a row; the last rows seen on timeout."""
        deadline, settled, rows = time.time() + timeout_min * 60, 0, []
        while time.time() < deadline:
            try:
                rows = self.rows(ids)
            except RuntimeError as cause:
                log(str(cause))
                time.sleep(POLL_SEC)
                continue
            latest = latest_states(rows)
            ended = sum(1 for i in ids if latest.get(i) in TERMINAL)
            log(f"ended {ended} of {len(ids)}")
            settled = settled + 1 if ended == len(ids) else 0
            if settled >= 2:
                return rows
            time.sleep(POLL_SEC)
        return rows

    def wait_state(self, task_id: str, state: str, timeout_min: int = 10) -> bool:
        deadline = time.time() + timeout_min * 60
        while time.time() < deadline:
            try:
                if any(r["state"] == state for r in self.rows([task_id])):
                    return True
            except RuntimeError as cause:
                log(str(cause))
            time.sleep(5)
        return False

    def open_attempts(self) -> list[str]:
        return [r["id"] for r in hubsql(f"select id from lane_pilot_attempt where run_id='{self.run_id}' and state in ({','.join(repr(s) for s in OPEN_STATES)});")]

    def quiet(self) -> None:
        """Nothing of this scenario may run on into the next one."""
        for attempt in self.open_attempts():
            log(f"cancelling {attempt}")
            bb("lane-pilot", "cancel", attempt)

    def finish(self) -> list[str]:
        problems: list[str] = []
        out = err = ""
        for tries in range(30 if self.run_id else 0):
            rc, out, err = bb("lane-pilot", "finish", self.project)
            if rc == 0:
                log("run finished")
                break
            if tries >= 12:
                self.quiet()
            time.sleep(20)
        else:
            if self.run_id:
                problems.append(f"run could not be finished: {(out + err).strip()[:200]}")
        try:
            if not self.run_id:
                raise RuntimeError("no run")
            rows = hubsql(f"select thread_id as t from lane_pilot_attempt where run_id='{self.run_id}' and thread_id is not null union select holder_thread_id from lane_pilot_attempt where run_id='{self.run_id}' and holder_thread_id is not null;")
            writers = [next(iter(r.values())) for r in rows]
        except RuntimeError:
            writers = []
        for thread in [self.pm, *writers, self.source]:
            if thread and bb("thread", "archive", thread)[0] == 0:
                log(f"archived {thread}")
        return problems
