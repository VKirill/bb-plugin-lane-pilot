"""Region 0 · Phase graph, batch e (n120 … n139 without n132): the lessons stage and the phase control work (docs/sma-evidence.md, «Trace choice»).

The lessons analysis, its reviewer, the memory door and the book section write at most the parts every phase writes, and the control nodes (the folder, the stage commands, the stage title,
the queue order, the gates) are pure checks, so the node-level trace is this scene. The probe (sma_r00_e_probe.ts, run by vite-node) runs the REAL code of the commit under drill — the phase
driver on a scratch database and a fake host, the auto stages with a fake engine, the real workflow engine on workflows/retrospective.json, the phase logic — with no model, no hub write and
nothing outside the machine; prove_e() compares each observation with the result the card expects. The observations live in tests/sma/r00-world-e.ts (`observe.<name>`).
The region scene sma_r00.py only imports the batch modules; run: scripts/lp-drill.sh --scenario sma_r00.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_E = [f"n{n}" for n in list(range(120, 132)) + list(range(133, 140))]
PROBE_E = ROOT / "scripts/lp_drill/scenes/sma_r00_e_probe.ts"
ANALYSIS = "The plan missed the empty-cell case; a check per promise would have caught it."
REFUSED = "the lessons are not proven read by their reviewer"
NOTE = {"kind": "note", "audience": "subagent", "content": f"Phase «Hud» lessons: {ANALYSIS}", "concepts": ["phase", "lessons"]}


def prove_e(proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_E)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_E:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    def seen(name: str) -> dict:
        value = s.get(name)
        return {} if not isinstance(value, dict) or "threw" in value else value

    # n120 the pass starts the analysis for a phase at lessons with a run and no analysis, handed the run; n121 the command is the retrospective graph.
    st = seen("lessonsStart")
    done_row = seen("lessonsDone").get("row", {})
    proofs.prove("n120", st.get("due") == {"kind": "lessons"} and st.get("withAnalysis") is None and st.get("noRun") is None and st.get("runId") == "r" and st.get("auto") == "lessons"
                 and done_row.get("why") == "a return" and done_row.get("analysis") == ANALYSIS, f"due {st.get('due')}, handed run {st.get('runId')}, row after the analysis {done_row.get('why')!r}")
    rt = seen("retro")
    proofs.prove("n121", st.get("workflow") == "retrospective" and rt.get("path") == ["retro", "living", "stage", "done"] and rt.get("status") == "succeeded"
                 and rt.get("output") == {"status": "done", "insights": [{"id": "INS-1a2b3c4d"}, {"id": "INS-5e6f7a8b"}], "retro_path": "retro/r-sample.md", "candidates_staged": 2},
                 f"started {st.get('workflow')}, path {rt.get('path')}, output status {rt.get('output', {}).get('status')}")
    # n122 / n123 / n124 author, independent reviewer, the bytes the reviewer saw.
    d = seen("lessonsDone")
    r = seen("lessonsRefused")
    out = r.get("out", {})
    why = lambda run: (out.get(run) or {}).get("why")
    proofs.prove("n122", d.get("row", {}).get("author") == "thr_retro" and d.get("analysisPart") == [f"{ANALYSIS} (by thr_retro, read by thr_stage in wf_read, input {d.get('measured12')})"], f"author {d.get('row', {}).get('author')}")
    proofs.prove("n123", d.get("row", {}).get("reviewer") == "thr_stage" and why("wf_self") == ["the reviewer of wf_self is not a session other than the analysis's author"]
                 and (out.get("wf_self") or {}).get("message") == REFUSED and r.get("stage") == "lessons" and r.get("memory") == 0, f"reviewer {d.get('row', {}).get('reviewer')}, own session: {why('wf_self')}")
    proofs.prove("n124", why("wf_none") == ["workflow run wf_none is not in the journal: the lessons name the run whose reviewer read them"]
                 and why("wf_other") == ["workflow run wf_other belongs to project OTHER, not to this phase's projA"]
                 and why("wf_elsewhere") == ["the reviewer step «stage» of wf_elsewhere did not receive these bytes: the analysis is not in its input"]
                 and why("wf_forged") == ["the journal's measurement of the reviewer's input does not match its bytes in wf_forged"]
                 and why("wf_nostage") == ["no finished reviewer step «stage» in workflow run wf_nostage"] and d.get("row", {}).get("hash") is True and d.get("row", {}).get("reviewRun") == "wf_read",
                 f"elsewhere: {why('wf_elsewhere')}, forged: {why('wf_forged')}")
    # n125 the note through the memory door; n126 the draft with the owner's word on.
    proofs.prove("n125", d.get("memory") == [NOTE] and d.get("row", {}).get("draft") is None, f"memory rows {d.get('memory')}")
    dr = seen("lessonDraft")
    no = seen("lessonDeclined")
    proofs.prove("n126", dr.get("staged") == {"stage": "closed", "draft": {"state": "staged", "text": NOTE["content"]}, "memory": 0, "parts": ["the lesson waits as a draft for the owner's word «lesson»"]}
                 and dr.get("after") == {"draft": "applied", "memory": [NOTE], "parts": ["the owner applied the lesson draft: it is in memory"]}
                 and no == {"state": "declined", "memory": 0, "parts": ["the owner declined the lesson draft"], "applied": []}, f"staged {dr.get('staged', {}).get('draft')}, memory before the yes {dr.get('staged', {}).get('memory')}, declined {no.get('state')}")
    # n127 a refused write is booked with the door's words; n129 a later pass finishes the same lesson; n128 the book section.
    rf = seen("lessonRefused")
    proofs.prove("n127", rf.get("mid") == {"state": "staged", "error": "memory door closed", "memory": 0, "parts": ["the memory door refused the lesson: memory door closed"], "applied": []}, f"after the refusal {rf.get('mid')}")
    proofs.prove("n129", rf.get("after") == {"state": "applied", "error": None, "memory": [NOTE], "analysis": ANALYSIS, "applied": ["the owner applied the lesson draft: it is in memory"]}, f"after the later pass {rf.get('after')}")
    bk = seen("bookSection")
    first = f"**analysis** — {ANALYSIS} (by thr_retro, read by thr_stage in wf_read, input {d.get('measured12')})"
    proofs.prove("n128", rf.get("lessonsSection") == [first, "**staged** — the lesson waits as a draft for the owner's word «lesson»", "**memory_refused** — the memory door refused the lesson: memory door closed",
                                                     "**lesson_applied** — the owner applied the lesson draft: it is in memory"] and bk.get("heads", [None] * 8)[7] == "## 8. Lessons" and bk.get("chain") == "chain: intact (5 parts)"
                 and bk.get("otherSection") is False, f"lessons section {rf.get('lessonsSection')}")
