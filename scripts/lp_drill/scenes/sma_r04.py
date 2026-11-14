"""Region 4 · Daemon tick: the region scene of the SMA-parity proof (docs/sma-evidence.md, «Trace choice»).

The card's «daemon pass» is this plugin's registered schedules plus the writer start's admission. The probe (sma_r04_probe.test.ts, run by vitest) boots the plugin or
mounts the phase driver on a fake host that keeps every schedule registration, fires the SCHEDULE itself (the phase pass, the silence sweep, the
backlog scan), and reads the effect from the database, the messages sent and the files on disk. No model, no hub, no network; the real code of the
checkout under drill. The scene compares each value with the node card's expected result and proves the node with the observed value.

Run: scripts/lp-drill.sh --scenario sma_r04   (add --dry-run to list the nodes). It is model-free, so it runs anywhere the checkout has node_modules.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = [f"n{n}" for n in range(415, 440)]
CONFIG = "scripts/lp_drill/scenes/sma_r04.vitest.config.ts"


def _get(seen: dict, section: str) -> dict:
    """One probe section; an errored or missing one is returned as {} so every node of it fails with the section's error in its detail."""
    value = seen.get(section)
    return value if isinstance(value, dict) and "error" not in value else {}


def _why(seen: dict, section: str) -> str:
    value = seen.get(section)
    return f"section {section} did not run: {value.get('error') if isinstance(value, dict) else 'missing'}"


def scenario_sma_r04(tmp: Path) -> dict:
    proofs = Proofs()
    out = tmp / "sma_r04_probe.json"
    done = subprocess.run(["npx", "vitest", "run", "--config", CONFIG], cwd=ROOT, capture_output=True, text=True, timeout=900, env={**os.environ, "SMA_R04_OUT": str(out)})
    try:
        seen = json.loads(out.read_text())
    except (OSError, ValueError):
        return proofs.verdict("sma_r04", [f"the probe wrote no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-400:]}"])

    def prove(node: str, section: str, check, detail) -> None:
        data = _get(seen, section)
        if not data:
            proofs.prove(node, False, _why(seen, section))
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n415 Tick: the plugin registers its pass as an isolated schedule that skips an overlap, and the fired timer moves a phase one step, once.
    prove("n415", "timer", lambda d: d["options"].get("isolated") is True and d["options"].get("overlap") == "skip" and d["before"] == 0 and d["after"] == 1 and d["again"] == 1 and "phase-drive" in d["names"],
          lambda d: f"phase-drive registered {d['options']}; PM messages about the phase before the timer {d['before']}, after it {d['after']}, after a second timer {d['again']}")
    # n416 Conveyor switch: off, a queued task takes no writer and says it waits; on, it starts by itself.
    prove("n416", "conveyor", lambda d: d["waiting"] and d["whileOff"]["spawned"] == [] and d["whileOff"]["held"] is True and d["whileOff"]["state"] == "queued" and d["resumed"] and d["spawned"] == ["a1"],
          lambda d: f"conveyor off: spawned {d['whileOff']['spawned']}, attempt {d['whileOff']['state']}, receipt «{str(d['whileOff']['receipt'])[:60]}»; on: spawned {d['spawned']}")
    # n417 Spend left by a stopped daemon: a fresh state counts the spend the cursors know, and later results move on from it.
    prove("n417", "spend", lambda d: d["seeded"] == 5000 and d["later"] == 5200, lambda d: f"seeded budget {d['seeded']} tokens, after a later result {d['later']}")
    # n418 Liveness sweep: nudge, nudge, end; a later pass touches nothing.
    prove("n418", "sweep", lambda d: [(s["count"], s["ended"]) for s in d["seen"]] == [(1, None), (2, None), (2, True), (2, True)],
          lambda d: f"passes (count, ended): {[(s['count'], s['ended']) for s in d['seen']]}")
    # n419 Ledger reconciled with queue: the attempt with no thread gets BB's thread, a queued one is left to the queue.
    prove("n419", "reconcile", lambda d: d["before"] is None and d["thread"] == "writer-found" and d["state"] == "running" and "attR" in d["resumed"] and d["queuedThread"] is None and d["queuedState"] == "queued",
          lambda d: f"spawn_unknown attempt: thread {d['before']} -> {d['thread']}, {d['state']}; queued attempt stays {d['queuedState']}")
    # n420 Failure journal: one line per failed task of every project, with its latest reason, asked through the PM's queue tool.
    prove("n420", "bugs", lambda d: d["lines"] == [["p1", "t1", "second boom"], ["p2", "t2", "second boom"]] and d["direct"] == 2, lambda d: f"queue failures: {d['lines']}")
    # n421 Copy sweep: merged and cancelled copies go, the unmerged one stays and is named, one janitor row for the pass.
    prove("n421", "copies", lambda d: d["status"] == "ok" and d["mergedGone"] and d["unmergedKept"] and d["row"]["removed"] >= 1 and d["row"]["keptUnmerged"] == 1 and d["reportNamesUnmerged"],
          lambda d: f"pass {d['status']}: merged copy removed {d['mergedGone']}, unmerged copy kept {d['unmergedKept']}, janitor row {d['row']}")
    # n422 Intake: the scan, fired by its schedule, sends the first ready item once a day.
    prove("n422", "intake", lambda d: d["first"] == ["t-01"] and d["second"] == ["t-01"] and d["sent"] == 1, lambda d: f"issued after the first scan {d['first']}, after the second the same day {d['second']}, messages {d['sent']}")
    # n423 Aging signal: counted from the last real movement, said once a day, stored nowhere.
    prove("n423", "aging", lambda d: d["four"] == ["no movement for 4 day(s) at discussion"] and d["again"] == 1 and d["stored"] is False, lambda d: f"aging parts {d['four']}, after a repeat pass {d['again']}, stored on the record {d['stored']}")
    # n424 Retry what retries itself: a product failure stays, a harness or machine fault is parked and re-queued by the sweep.
    prove("n424", "autoretry", lambda d: d["product"] is False and d["harness"] is True and d["early"] == [] and d["machine"] is True and d["late"] == ["T2"] and d["resumed"] == ["T2"],
          lambda d: f"product parked {d['product']}, harness parked {d['harness']}, sweep too early {d['early']}, later {d['late']}, re-queued {d['resumed']}")
    # n425 Call about waiting acceptance: the turn that needs the owner's word is a row on his list, and the PM is told.
    prove("n425", "calls", lambda d: d["row"] == {"key": f"phase-word:{d['phaseId']}:planning", "kind": "word", "source": "phase"} and d["told"], lambda d: f"owner row {d['row']}, PM told {d['told']}")
    # n426 Call about a stalled batch: a blocked piece is named to the PM once.
    prove("n426", "stalled", lambda d: d["first"] == 1 and d["second"] == 1 and d["to"] == "thr_pm", lambda d: f"«hud is blocked» sent {d['first']} time after the first pass, {d['second']} after the second, to {d['to']}")
    # n427 Hold an overspent batch: a wave whose appetite does not fit is not issued and says so; one that fits goes.
    prove("n427", "issue", lambda d: d["budgetHeld"] == [] and "wave budget" in (d["budgetError"] or "") and d["budgetFits"] == ["a"], lambda d: f"over budget issued {d['budgetHeld']} ({str(d['budgetError'])[:50]}); fitting wave issued {d['budgetFits']}")
    # n428 Draftsman for a batch: screens decide «drawing needed», and the pass at design starts lp.draw.
    prove("n428", "draftsman", lambda d: d["decision"] == "needed" and d["started"] == ["lp.draw"] and d["auto"] == "draw", lambda d: f"decision {d['decision']}, workflows started by the pass {d['started']}, auto stage {d['auto']}")
    # n429 Verify ready waves: a wave with all pieces accepted is written once, with its lines.
    prove("n429", "waves", lambda d: len(d["once"]) == 1 and "✓" in d["once"][0] and d["twice"] == 1, lambda d: f"wave lines {d['once']}, after a second pass {d['twice']}")
    # n430 Read stopped waves: the stop is the phase row, read by a driver built later.
    prove("n430", "stopwave", lambda d: d["newDriverState"] == "paused" and d["stoppedPart"] is True and d["issuedAfter"] == 0, lambda d: f"a new driver reads the phase as {d['newDriverState']}, pieces issued by the next pass {d['issuedAfter']}")
    # n431 Live wave pieces stand: the queued piece is canceled, the running writer is corrected after its turn.
    prove("n431", "stopwave", lambda d: d["canceled"] == ["piece1"] and d["toWriter"] == [{"mode": "queue-if-active", "wave": True}] and d["corrected"] is True, lambda d: f"canceled {d['canceled']}, messages to the running writer {d['toWriter']}")
    # n432 Which lanes can work: a held provider is skipped, a chain all held parks.
    prove("n432", "lanes", lambda d: d["free"] == "b" and d["freeIndex"] == 1 and "breaker_open" in d["holds"][0] and d["allFree"] is None and "writer_provider_unavailable:" in (d["allShortest"] or "") and d["wakeLater"],
          lambda d: f"free lane {d['free']}, holds {d['holds']}, all-held chain free {d['allFree']} ({d['allShortest']})")
    # n433 Batch issue capacity: only as many pieces as the cap.
    prove("n433", "issue", lambda d: d["capped"] == ["a"] and d["open"] == ["a", "b"], lambda d: f"cap 1 issued {d['capped']}, cap 8 issued {d['open']}")
    # n434 Free seat in the house: a seat taken is not issued again; one worker means one seat.
    prove("n434", "issue", lambda d: d["taken"] == [] and d["inline"] == ["a"], lambda d: f"cap 1 with a piece at work issued {d['taken']}, one worker issued {d['inline']}")
    # n435 All workers busy: a second seat waits for the first.
    prove("n435", "pool", lambda d: d["whileTaken"] is False and d["afterRelease"] is True and d["busy"] is False, lambda d: f"second acquire done while taken {d['whileTaken']}, after the release {d['afterRelease']}")
    # n436 Claim: a hold that came while the task waited for a seat stops it; releasing starts it.
    prove("n436", "claim", lambda d: d["waiting"] and d["heldNoted"] and d["whileHeld"] == [] and d["released"], lambda d: f"spawned while held {d['whileHeld']}, after release {d['released']}")
    # n437 Idle pass: the pass names why it took nothing.
    prove("n437", "idle", lambda d: d["none"] == {"moved": 0, "idle": "no live phase"} and d["waits"] == {"moved": 0, "idle": "all live phases wait for the PM"} and d["work"] == {"moved": 0, "idle": "all live phases at work"}, lambda d: f"{d['none']} / {d['waits']} / {d['work']}")
    # n438 Lease while preparing: an attempt with no process stays open for 14 minutes, the stall ends it writer_start_stalled.
    prove("n438", "lease", lambda d: d["young"] == {"settled": False, "state": "spawn_requested"} and d["status"] == "spawn_rejected" and "writer_start_stalled" in (d["reason"] or ""), lambda d: f"at 14 min {d['young']}; at 16 min {d['status']}: {str(d['reason'])[:60]}")
    # n439 Seat and lease released: a start whose spawn throws leaves the attempt blocked and the seat free.
    prove("n439", "finally", lambda d: d["blocked"] and d["seat"] == "free", lambda d: f"attempt blocked {d['blocked']}, pool seat {d['seat']}")
    return proofs.verdict("sma_r04", checked=len(NODES))
