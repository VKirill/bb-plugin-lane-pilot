"""Region 1 · Task graph, batch c: the attempt's life (working copy, launch, prompts, session, its ends) proved by the region scene sma_r01 (docs/sma-evidence.md, «Trace choice»).

These nodes write no row of a hub table of their own that a trace could read (a copy, a launch line, a prompt, a gate). The probe runs the REAL code of the commit under
drill on scratch repositories and a scratch database (no model, no hub write), and prove_c() compares each result with what the node's card expects.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_C = ["n222", "n223", "n224", "n225", "n226", "n230", "n231", "n232", "n234", "n235", "n237", "n238", "n239", "n240", "n241", "n243", "n244", "n245", "n246", "n247", "n250", "n254", "n255"]
PROBE_C = ROOT / "scripts/lp_drill/scenes/sma_r01_c_probe.ts"


def prove_c(proofs: Proofs, tmp: Path) -> None:
    done = subprocess.run(["npx", "tsx", str(PROBE_C)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_C:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if "fatal" in s:
        for node in NODES_C:
            proofs.prove(node, False, f"the probe failed: {s['fatal']}")
        return

    def has(node: str) -> dict | None:
        value = s.get(node)
        if isinstance(value, dict) and "error" in value:
            proofs.prove(node, False, f"the probe step failed: {value['error']}")
            return None
        return value

    # n222 The copy is cut on its own lane/<name> branch from the named commit; the founder's tree is untouched.
    v = has("n222")
    if v:
        proofs.prove("n222", v["made"] == {"status": "ready", "branch": "lane/lpattempt_c1", "baseSha": v["first"]} and v["bThere"] is False and v["laneBranch"] == v["first"]
                     and v["founderHead"] == v["second"] and v["founderStatus"] == "", f"copy {v['made']} on the older commit, b.txt there {v['bThere']}, founder head kept {v['founderHead'] == v['second']}, founder status {v['founderStatus']!r}")
    # n223 A refused copy parks the attempt blocked and puts one reason before the owner, once.
    v = has("n223")
    if v:
        proofs.prove("n223", v["result"] == "break" and v["attempt"] == "blocked" and v["items"] == 1 and v["what"] == "Рабочая копия для задачи не создалась" and "Причина: path already exists." in v["why"],
                     f"routing {v['result']}, attempt {v['attempt']}, owner items {v['items']} ({v['what']}): {v['why']}")
    # n224 A copy the daemon left failed is refused before launch; a ready one is taken.
    v = has("n224")
    if v:
        proofs.prove("n224", v["destroyed"] == "failed" and v["refused"] == "attempt_worktree_provision_failed:failed" and v["taken"] == {"environmentId": "env-1"}, f"destroyed copy {v['destroyed']}, failed {v['refused']}, ready {v['taken']}")
    # n225 A phase's verify copy lives on phase/<id> inside the base checkout's .git, from its HEAD; the base stays clean.
    v = has("n225")
    if v:
        proofs.prove("n225", v["tree"] == {"path": v["expectedPath"], "startSha": v["second"]} and v["tree"]["path"].endswith("/app/.git/lp-phases/ph_c1") and v["branch"] == "phase/ph_c1" and v["baseStatus"] == "",
                     f"phase copy {v['tree']} on branch {v['branch']}, base status {v['baseStatus']!r}")
    # n226 A task that follows a drawing names its files as a line of its inputs; one without carries none.
    v = has("n226")
    if v:
        proofs.prove("n226", v["drawn"] == ["drawing: design/ph/UI-SPEC.md, design/ph/main.png — read it first; the screens you change match it, and the acceptance checks the drawing is unchanged."] and v["plain"] == [], f"drawing lines {v['drawn']}, without a drawing {v['plain']}")
    # n230 The person's deny rules ride into a helper's settings, never their allow list nor user hooks; a PM keeps its own layer.
    v = has("n230")
    if v:
        proofs.prove("n230", v["status"] == 0 and v["deny"] == ["Bash(rm -rf /)", "Read(~/.ssh/**)"] and v["allow"] is None and v["userSourceOff"] and v["commands"] == ["python3 <dir>/hooks/guard_shell.py"] and v["dropped"] and v["pmDeny"] == ["Bash(rm -rf /)"] and v["pmHooks"] == 2,
                     f"helper deny {v['deny']}, allow {v['allow']}, hooks {v['commands']}, unreadable hook dropped {v['dropped']}; PM deny {v['pmDeny']}, hooks {v['pmHooks']}")
    # n231 A role's connections plus the mandatory ones; an owner's list replaces the role's but keeps the mandatory.
    v = has("n231")
    if v:
        proofs.prove("n231", v["mandatory"] == ["bb-bridge"] and v["writer"] == {"names": ["bb-bridge", "gitnexus"], "source": "role"} and v["owner"] == {"names": ["bb-bridge", "context7"], "source": "owner"} and v["all"] == {"names": None, "source": "owner"},
                     f"writer {v['writer']}, owner's list {v['owner']}, all {v['all']}")
    # n232 A switched-off conveyor holds every run until it is switched on; the start says how to turn it on.
    v = has("n232")
    if v:
        proofs.prove("n232", v["before"] is False and v["heldOff"] == [True, True] and v["reason"] == "maintenance" and v["after"] is False and v["keyAfter"] is None
                     and v["line"] == "Lane Pilot: the conveyor is OFF since <since> (maintenance): no new work is issued. Turn it on with: bb lane-pilot conveyor on", f"held off {v['heldOff']}, after on {v['after']}, line {v['line']}")
    # n234 A UI task's writer gets the browser skill; a plain one does not.
    v = has("n234")
    if v:
        proofs.prove("n234", v["ui"] == ["browser-automation"] and v["plain"] == [] and v["uiNeeds"] is True and v["plainNeeds"] is False, f"UI task skills {v['ui']}, plain task skills {v['plain']}")
    # n235 A brief carries at most five accepted similar works and no blocked one.
    v = has("n235")
    if v:
        proofs.prove("n235", v["listed"] == 5 and v["blocked"] is False and v["approach"] is True, f"similar works listed {v['listed']} of 7 accepted and 2 blocked, a blocked one in it {v['blocked']}")
    # n237 The launch line carries the turn ceiling as a whole number and the writer's full deny list; a PM's carries neither.
    v = has("n237")
    if v:
        proofs.prove("n237", v["turns"] == "150" and v["denyList"] is True and v["pmTurns"] is False and v["pmDeny"] is False, f"ceiling for 150.7 is {v['turns']}, writer deny list {v['denyList']}, PM turns/deny {v['pmTurns']}/{v['pmDeny']}")
    # n238 At the design stage the PM is told Lane Pilot draws itself, not to start a designer; with a drawing recorded that line is gone.
    v = has("n238")
    if v:
        proofs.prove("n238", v["first"] == "Phase ph_c «Hud» — stage 3, design (pieces that change screens: hud). Lane Pilot draws the screens itself (lp.draw: design-lead draws into .agents/phases/ph_c/design/ with UI-SPEC.md, another role checks); its drawing comes to this chat. Do not start a designer; a correction for the drawing goes to lane_pilot_phase {action:\"correct\", phaseId:\"ph_c\", note}." and v["drawnHasNoDesignerLine"] is True,
                     f"first line {v['first']}")
    # n239 The drawing answer names feasibility; no answer or a contradiction keeps the phase at design.
    v = has("n239")
    if v:
        proofs.prove("n239", v["shape"] is True and v["none"] == {"ok": False, "why": ["no feasibility answer: feasible, or the contradiction with the plan"]}
                     and v["contradiction"]["ok"] is False and v["contradiction"]["why"][0].startswith("the drawing contradicts the plan: the bar cannot be both fixed and scrolling") and v["ok"] == {"ok": True}, f"no answer {v['none']}, contradiction {v['contradiction']}, feasible {v['ok']}")
    # n240 The brief names the writer's role and the picked skills, or the catalog when skills are broad.
    v = has("n240")
    if v:
        proofs.prove("n240", v["first"] == "You are Lane Pilot writer, the Lane Pilot writer for one bounded task." and v["skillsLine"] and v["pickedCatalog"] is False and v["broadCatalog"] is True and v["broadSkillsLine"] is False, f"role line {v['first']!r}, picked line {v['skillsLine']}, catalog when broad {v['broadCatalog']}")
    # n241 A drawing edited after the owner's yes does not launch: nothing is issued, the owner's word is told stale.
    v = has("n241")
    if v:
        proofs.prove("n241", v["dispatched"] == 0 and v["staleNotes"] == 1 and v["note"] is True, f"writers dispatched {v['dispatched']}, stale-consent notes {v['staleNotes']} («changed since it was recorded» {v['note']})")
    # n243 What a session said is kept as a masked, bounded excerpt; the hash and length are of the whole text.
    v = has("n243")
    if v:
        proofs.prove("n243", v["charsMatch"] and v["bounded"] and v["leaked"] is False and v["hash"], f"stream chars of the whole text {v['charsMatch']}, bounded {v['bounded']}, credential left in the excerpt {v['leaked']}")
    # n244 The PM's note reaches a running writer now (steer) or at its next turn (queue).
    v = has("n244")
    if v:
        proofs.prove("n244", v["delivered"] is True and v["modes"] == ["steer-if-active", "queue-if-active"] and v["thread"] == "thr_w" and v["state"] == "running", f"delivery modes {v['modes']} to {v['thread']}, attempt {v['state']}")
    # n245 A blocked writer's question is answered in its own thread; the attempt runs again and no new one is made.
    v = has("n245")
    if v:
        proofs.prove("n245", v["result"] == {"ok": True} and v["sentTo"] == ["thr_w"] and v["carries"] and v["state"] == "running" and v["thread"] == "thr_w" and v["restarts"] == 1 and v["writerThreadId"] == "thr_w" and v["turnSent"] is True and v["attempts"] == 1,
                     f"turn sent to {v['sentTo']}, attempt {v['state']} on {v['thread']}, writer task restarts {v['restarts']}, attempts of the task {v['attempts']}")
    # n246 A correction the running writer could not take rides the next brief once.
    v = has("n246")
    if v:
        proofs.prove("n246", v["delivered"] is False and v["first"] == "the PM corrected the task meanwhile:\n- acceptance: also cover empty input" and v["second"] is None, f"first take {v['first']!r}, second take {v['second']!r}")
    # n247 A dangerous call is refused and a ticket filed once; the PM's grant lets the same command through once.
    v = has("n247")
    if v:
        proofs.prove("n247", v["firstRefused"] and v["filed"] == 1 and v["told"] and v["againRefused"] and v["afterAgain"] == 1 and v["grantedOk"] and v["used"] and v["reusedRefused"], f"tickets filed {v['filed']} (after asking again {v['afterAgain']}), granted call passed {v['grantedOk']}, permit marked used {v['used']}, a second use refused {v['reusedRefused']}")
    # n250 Files the checks wrote outside owns_paths are undone; the task's own and the listed ones stay.
    v = has("n250")
    if v:
        proofs.prove("n250", v["reverted"] == ["docs/x.md", "reports/out.js"] and v["failed"] == [] and v["restored"] == "original\n" and v["reportGone"] and v["own"] == "export const n = 1;\n" and v["kept"] == "kept by the caller\n", f"undone {v['reverted']}, own file kept {v['own']!r}, listed file kept {v['kept']!r}")
    # n254 Frames read closed, spinning and progressing; a spinning writer is nudged with the repeated call named.
    v = has("n254")
    if v:
        proofs.prove("n254", v["spinning"] == "spinning" and v["progressing"] == "progressing" and v["closed"] == "closed" and v["named"] and v["swept"] == [{"attemptId": "a1", "action": "nudged", "count": 1}] and v["nudgeNamesCall"], f"frames {v['spinning']}/{v['progressing']}/{v['closed']}, sweep {v['swept']}")
    # n255 A work is accepted only on a stage decided by code; a model's opinions alone, or nothing, are refused with the stages named.
    v = has("n255")
    if v:
        proofs.prove("n255", v["advisory"] == "acceptance_without_code_proof: only advisory stages passed (code-critique); a model's opinion cannot accept a task on its own" and v["none"] == "acceptance_without_code_proof: no stage passed"
                     and v["verification"] is None and v["receipt"] is None and v["mixed"] is None, f"advisory only {v['advisory']}; none {v['none']}; verification {v['verification']}")
