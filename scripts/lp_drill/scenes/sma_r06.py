"""Region 6 · Conversation and intake: the region scene (docs/sma-evidence.md, «Trace choice»).

The conversation-side nodes of this region (the checks asked for in the chat, the facts answered from the books, the intake's reading of an owner
message, the live board, the owner's yes and the proposal) write no row of their own, so the node-level trace is this scene. The probe
(sma_r06_probe.ts) runs the REAL code of the commit under drill on the scratch worlds of tests/sma/r06-world.ts (a fake host, a scratch database,
stand-in tools: no model, no hub write, nothing outside the machine) and the scene compares every value with the result the node's card names.

Later batches of this region add their nodes to NODES and to the probe/scene below; the proofs are grouped by card, one prove() each.
Nodes of this region whose logic lives in bb-core (core:) have nothing to prove here. Run: scripts/lp-drill.sh --scenario sma_r06
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r06_b import NODES_B, prove_b

NODES = ["n530", "n534", "n535", "n536", "n537", "n538", "n539", "n541", "n542", "n543", "n544", "n545", "n547", "n548", "n550", "n551", "n552",
         "n553", "n554", "n555", "n556", "n558"]
NODES = NODES + NODES_B
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r06_probe.ts"


def scenario_sma_r06(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the plugin's rooms, whose barrel files tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r06", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n530 History read: a stored turn that reads like a command is text to the intake (kind small, by rules, nothing started); a machine notice is not read.
    st = s["storedTurn"]
    ok = (s["machine"] == [True, False] and st["machineRead"] is None and st["commandRequestId"] == "r2" and st["commandKind"] == "small"
          and st["commandBy"] == "rules" and st["commandStarts"] == 0 and st["commandPhases"] == 0)
    proofs.prove("n530", ok, f"machine notice read as {st['machineRead']}; a command-shaped turn read as {st['commandKind']} by {st['commandBy']}, graphs started {st['commandStarts']}, phases opened {st['commandPhases']}")

    # n534 / n535 The whole request selects the recipe; only quick runs the PM's commands, and no byte of the phrase becomes one.
    r = s["recipes"]
    proofs.prove("n534", s["recipeWords"] == ["quick", "full", "browser", "quick"], f"«run tests», «sma green», «window», an injected phrase -> {s['recipeWords']}")
    ok = [r["quick"], r["full"], r["browser"]] == ["quick", "full", "browser"] and r["ran"] == ["npm test"] and "run-goal" in r["fullNext"] and "browser_qa" in r["browserNext"]
    proofs.prove("n535", ok, f"the check tool picked {[r['quick'], r['full'], r['browser']]}; commands that ran on the host {r['ran']}; full -> {r['fullNext'][:40]!r}, browser -> {r['browserNext'][:40]!r}")

    # n536 A check as an operation: a repeat is the one receipt, a changed request is a new run, a late repeat is a new check.
    d = s["dedupe"]
    ok = d == {"runs": 3, "sameId": True, "deduplicated": True, "secondState": "passed", "otherId": True, "otherDeduplicated": None, "laterDeduplicated": None}
    proofs.prove("n536", ok, f"host runs {d['runs']} for four calls; repeat deduplicated={d['deduplicated']} state {d['secondState']}, changed request deduplicated={d['otherDeduplicated']}, late repeat {d['laterDeduplicated']}")

    # n537 Run in a throwaway copy: the sandbox starts from a clean environment and binds .git, .agents and .cls read-only.
    sb = s["sandbox"]
    ok = sb["clearenv"] and sb["home"] and sb["guards"] == {".git": "--ro-bind same", ".agents": "--ro-bind same", ".cls": "--ro-bind same"}
    proofs.prove("n537", ok, f"--clearenv {sb['clearenv']}, HOME the scratch folder {sb['home']}, protected roots {sb['guards']}")

    # n538 Five required measures: command, folder, expected exit, time limit, evidence — and the sandbox's own facts.
    m = s["measures"]
    me = m["measure"]
    ok = (me["command"] == "npm test" and me["cwd"] == "/ws" and me["expectExit"] == 0 and me["timeoutSec"] == 30 and me["exitCode"] == 1 and me["passed"] is False
          and "ok npm test" in me["evidence"] and me["env"] == "cleared" and me["publication"] == "closed" and m["readSame"] and m["throwawayChanged"] is False and m["liveChanged"] is True
          and m["fiveFacts"]["backend"] == "linux-bubblewrap" and m["fiveFacts"]["copy"] == "worktree")
    proofs.prove("n538", ok, f"measure {{command {me['command']!r}, folder {me['cwd']}, expected exit {me['expectExit']}, limit {me['timeoutSec']} s, exit {me['exitCode']}}}; a changed protected root passes in a throwaway copy={m['throwawayChanged']}, in the live checkout={m['liveChanged']}")

    # n539 Stop a check: the host job is cancelled and the receipt names the stopped command.
    sp = s["stop"]
    ok = sp == {"stopped": True, "idMatches": True, "state": "stopped", "stoppedCommand": "npm test --watch", "passed": False, "cancelled": True, "rereadState": "stopped"}
    proofs.prove("n539", ok, f"stop -> {sp}")

    # n541 «Accepted» before the engine: a dispatched message is handed on as a queue event, no answer is sent.
    ac = s["accepted"]
    ok = ac["listens"] and ac["queued"] == [{"name": "message.dispatched", "id": ac["entryId"]}] and ac["sent"] == []
    proofs.prove("n541", ok, f"queue events handed on {ac['queued']}, messages sent in answer {len(ac['sent'])}")

    # n542 Shared turn assembly: one reading for the same message from two chats; a multi-line message is not a question.
    asm = s["assembly"]
    ok = asm["kinds"] == ["question", "question"] and asm["by"] == ["rules", "rules"] and asm["starts"] == 0 and asm["multiLine"] == "small"
    proofs.prove("n542", ok, f"two chats read «Что с задачей?» as {asm['kinds']} by {asm['by']}, graphs started {asm['starts']}; the same with a second line: {asm['multiLine']}")

    # n543 / n545 The board that rides every turn and the live dot: a PM chat sees its tasks (the running one marked), a writer chat its own task, others nothing.
    lv = s["live"]
    ok = lv["pmRole"] == "pm" and lv["pmTitles"] == ["Another task", "Fix the door"] and lv["pmRunning"] == ["Fix the door:running"] and lv["unknown"] is None and lv["leaksWords"] is False
    proofs.prove("n543", ok, f"PM chat {lv['pmTitles']}, running {lv['pmRunning']}, an unknown thread {lv['unknown']}")
    ok = lv["writerRole"] == "writer" and lv["writerPm"] == "thr_pm" and lv["writerTitles"] == ["Fix the door"] and lv["pmRunning"] == ["Fix the door:running"]
    proofs.prove("n545", ok, f"writer chat is {lv['writerRole']} of {lv['writerPm']} and sees {lv['writerTitles']}; the running task is marked live {lv['pmRunning']}")

    # n544 Phase discussion in the chat: the PM chat is sent the stage's step with the rubric and the card write.
    ds = s["discussion"]
    sent = ds["sent"]
    ok = (ds["stage"] == "discussion" and len(sent) == 1 and sent[0]["threadId"] == "thr_pm" and ds["next"] in sent[0]["text"]
          and "stage 1, discussion. Goal: skip empty cells" in ds["next"] and 'lane_pilot_phase {action:"context"' in ds["next"])
    proofs.prove("n544", ok, f"stage {ds['stage']}, messages to the PM chat {len(sent)}, the step starts {ds['next'][:90]!r}")

    # n547 Stop a reply: a queued attempt is canceled with no thread stop, a running one is stopped and its work recorded; a missing one is refused.
    c = s["cancel"]
    ok = (c["queuedResult"]["ok"] and c["stopsAfterQueued"] == [] and c["running"] == {"ok": True, "state": "canceled", "reason": None} and c["stops"] == ["thr_w"]
          and c["noted"] == ["attempt_w"] and c["writerState"] == "canceled" and c["missing"]["ok"] is False and c["missing"]["state"] == "missing")
    ts = s["turnStop"]
    ok = ok and ts == {"aState": "stopped_by_turn_stop", "aCommand": "tail -f a", "bStillRunning": True, "bState": "stopped_by_turn_stop"}
    proofs.prove("n547", ok, f"queued -> {c['queuedResult']['state']}, running attempt stopped threads {c['stops']} -> {c['writerState']}, missing -> {c['missing']['state']}; a check ends with its turn {ts['aState']}, the other thread's check kept running {ts['bStillRunning']}")

    # n548 Task from the conversation: the owner's «да» enqueues once through the intake road; a second «да» for the same key starts nothing, another key its own.
    h = s["handOver"]
    ok = (len(h["starts"]) == 2 and h["starts"][0]["requestId"] == "lead:road1" and h["starts"][1]["requestId"] == "lead:road2"
          and h["one"] == h["two"] == h["three"] == {"started": True, "via": "issue-quick", "id": "wf_1"})
    proofs.prove("n548", ok, f"three hand-overs of one key and one of another started {[row['requestId'] for row in h['starts']]}, all answered {h['three']}")

    # n550 / n553 / n554 / n555 / n556 What kind of question and the facts from the books.
    f = s["facts"]
    proofs.prove("n550", s["kinds"] == ["failure", "limit", "history", "stage", "board", "free", "failure"] and f["kinds"] == ["board", "limit", "history", "failure", "free"],
                 f"question kinds {s['kinds']}; the tool named {f['kinds']}")
    proofs.prove("n553", f["failureCount"] == 1 and f["failureClass"] not in (None, "free") and f["failureReason"] == "npm test exit 1" and f["modelCalls"] == 0,
                 f"a blocked attempt «npm test exit 1» is class {f['failureClass']!r}, model calls {f['modelCalls']}")
    proofs.prove("n554", f["spendTotal"] == 18 and f["spendModels"] == ["claude", "gpt"] and "lane_pilot_token_daily" in f["spendSource"], f"spend {f['spendTotal']} tokens over {f['spendModels']}, from {f['spendSource']}")
    proofs.prove("n555", f["counts"] == {"accepted": 1, "blocked": 1} and f["tasks"] == 2 and "lane_pilot_attempt" in f["boardSource"], f"board counts {f['counts']}, {f['tasks']} tasks, from {f['boardSource']}")
    proofs.prove("n556", f["finished"] == ["T1", "T2"] and "lane_pilot_attempt" in f["pastSource"], f"finished attempts {f['finished']}, from {f['pastSource']}")

    # n551 Consent is the whole message.
    proofs.prove("n551", s["consent"] == [True, True, False, False], f"«да!», «Да, запускай», «да, но поменяй кнопку», «yes please» -> {s['consent']}")

    # n552 Enqueue the latest draft: the planning yes counts only from the phase's own chat, under the plan's key.
    py = s["planningYes"]
    ok = "phase's own chat (thr_pm)" in (py["refusal"] or "") and py["afterOther"] == 0 and py["own"] == ["planning:yes:true"]
    proofs.prove("n552", ok, f"a yes from another thread -> {py['refusal']!r}, words recorded {py['afterOther']}; from the own chat {py['own']}")

    # n558 Proposal with a hash: a key, a refusal for another key and a stale one, one hash per plan.
    pr = s["proposal"]
    ok = (pr["hashShape"] and pr["same"] and pr["fewer"] and pr["otherContext"] and "changed since it was shown" in pr["wrongKey"] and pr["wordsAfterWrong"] == 0
          and "stale" in pr["staleRefusal"] and pr["signed"] == ["yes:true"] and pr["planKey"])
    proofs.prove("n558", ok, f"plan hash {pr['sha'][:12]}…; another key -> {pr['wrongKey'][:40]!r}, a 25 h old proposal with a 24 h term -> {pr['staleRefusal'][:40]!r}, the keyed yes signed {pr['signed']}")
    prove_b(proofs, tmp)
    return proofs.verdict("sma_r06", checked=len(NODES))
