"""Memory path probes: planted/cleaned anchors, thread text, the memory scenarios."""
from __future__ import annotations

import json
import time

from lp_drill.env import SANDBOX, STAMP
from lp_drill.hub import bb, hubsql, log, setting_rpc, RPC_MISSING
from lp_drill.report import verdict
from lp_drill.tasks import task_memory

def plant_memory_probe() -> dict:
    """`memory-probe --keep` before the PM starts, so the PM's first prompt can carry the probe rule. Exit 1 (a path red) still gives a report."""
    rc, out, err = bb("lane-pilot", "memory-probe", SANDBOX["project"], "--keep", timeout=180)
    try:
        report = json.loads(out)
    except ValueError:
        report = {}
    return {"rc": rc, "report": report if isinstance(report, dict) else {}, "error": (err or out).strip()[:300]}


def clean_memory_probe() -> None:
    bb("lane-pilot", "memory-probe", SANDBOX["project"], "--clean", timeout=120)


def thread_text(thread: str) -> str:
    """The thread's event log as raw JSON text: the first prompt an agent got is in it. Alphanumeric tokens survive JSON escaping."""
    if not thread:
        return ""
    rc, out, _ = bb("thread", "log", thread, "--json", "--limit", "100", timeout=90)
    return out if rc == 0 else ""


def memory_problems(report: dict, pm_text: str, writer_text: str | None) -> list[str]:
    """What is wrong with the memory delivery: the probe's rows, then the real PM prompt and the real writer brief. (2026-10-29) no terminal lane-memory."""
    problems: list[str] = []
    results = report.get("results") or []
    tokens = report.get("tokens") or {}
    if not results or not tokens:
        return ["the memory probe gave no report (is the plugin on the version that has memory-probe?)"]
    problems += [f"probe: {p}" for p in report.get("problems") or []]
    for row in results:
        if not row.get("found"):
            problems.append(f"path {row.get('path')} does not deliver: {row.get('detail')}")
        elif row.get("negativeOk") is False:
            problems.append(f"path {row.get('path')} pulled our records for an unrelated query: {row.get('detail')}")
    if tokens.get("rule") not in pm_text:
        problems.append("the drill's PM first prompt does not carry the probe rule (pm.start live)")
    if writer_text is None:
        problems.append("the probe task's writer thread did not start in time, so its brief could not be read")
    else:
        for kind in ("note", "core", "rule"):
            if tokens.get(kind) not in writer_text:
                problems.append(f"the real writer's first prompt does not carry the probe {kind} (writer.brief live)")
    return problems


def scenario_memory_paths(ctx: Context) -> dict:
    planted = ctx.memory_probe
    if not planted:
        return verdict("memory_paths", ["the probe was not planted before the PM started"])
    report = planted["report"]
    if not report:
        clean_memory_probe()
        return verdict("memory_paths", [f"memory-probe failed (exit {planted['rc']}): {planted['error'] or 'no output'}"])
    spec = task_memory(ctx.cwd)
    writer_text: str | None = None
    attempt = ""
    try:
        if not ctx.dispatch(spec):
            raise RuntimeError("dispatch-bb exited with an error")
        deadline = time.time() + 5 * 60
        while time.time() < deadline and writer_text is None:
            try:
                rows = [r for r in ctx.rows([spec["id"]]) if r.get("thread_id")]
            except RuntimeError as cause:
                log(str(cause))
                rows = []
            if rows:
                attempt = rows[-1]["id"]
                writer_text = thread_text(rows[-1]["thread_id"])
                break
            time.sleep(5)
        ctx.quiet()
        problems = memory_problems(report, thread_text(ctx.pm), writer_text)
    except RuntimeError as cause:
        problems = [str(cause)]
    finally:
        clean_memory_probe()
    return verdict("memory_paths", problems, token=report.get("token"), lpVersion=report.get("lpVersion"), paths=report.get("results"), skipped=report.get("skipped"),
                   unanswered=report.get("unanswered"), writerAttempt=attempt or None, dispatch=ctx.dispatches.get(spec["id"]))
def scenario_memory_thread(tmp: Path) -> dict:
    """M2: every ordinary BB thread of the project gets the L1 memory block (contributeInstructions); the drill reads the same
    block over the plugin RPC. A core fact written through the one door must be in it, another project's must not, and a PM
    thread gets nothing (its own resume block stays). Reads and writes the sandbox project only; the fact is deleted after."""
    project = SANDBOX["project"]
    thread = "drill-memory-thread"
    try:
        block = setting_rpc("memory_thread_block", {"projectId": project, "threadId": thread}).get("block")
    except Exception as cause:
        if RPC_MISSING.search(str(cause)):
            return verdict("memory_thread", [], deployed=False, note=f"the running plugin has no memory_thread_block yet: {str(cause)[:160]}")
        return verdict("memory_thread", [f"memory_thread_block failed: {str(cause)[:200]}"])
    problems: list[str] = []
    record_id = None
    try:
        if block is None:
            problems.append("an ordinary thread got no memory block")
        else:
            if len(block) > 1200:
                problems.append(f"the block is {len(block)} chars, over the 1200 cap")
            for needle in ("lane-memory search", "lane-memory write", "не в файлы"):
                if needle not in block:
                    problems.append(f"the block misses «{needle}»")
        token = f"drill-memory-{STAMP}"
        wrote = setting_rpc("session_memory_write", {"projectId": project, "kind": "core", "source": "drill",
                                                   "content": f"Drill fact {token}: the sandbox keeps one memory.", "concepts": ["drill"]})
        record_id = wrote.get("id")
        if not wrote.get("stored") and not record_id:
            problems.append(f"the drill fact was not stored: {wrote.get('reason')}")
        else:
            again = setting_rpc("memory_thread_block", {"projectId": project, "threadId": thread}).get("block") or ""
            if token not in again:
                problems.append("a core fact written through the door is not in the thread block")
            other = next((row["project_id"] for row in hubsql("select distinct project_id from lane_pilot_run limit 50") if row["project_id"] != project), None)
            if other:
                foreign = setting_rpc("memory_thread_block", {"projectId": other, "threadId": thread}).get("block") or ""
                if token in foreign:
                    problems.append("the block of another project carries this project's fact")
        pm = hubsql(f"select pm_thread_id as t from lane_pilot_run where project_id='{project}' and pm_thread_id is not null order by created_at desc limit 1")
        if pm:
            got = setting_rpc("memory_thread_block", {"projectId": project, "threadId": pm[0]["t"]}).get("block")
            if got is not None:
                problems.append("a PM thread got the ordinary-thread memory block")
    finally:
        if record_id:
            try:
                setting_rpc("memory_record_delete", {"projectId": project, "id": record_id})
            except Exception as cause:
                log(f"drill fact {record_id} was not deleted: {str(cause)[:160]}")
    return verdict("memory_thread", problems, deployed=True, chars=len(block or ""), fact=bool(record_id))
