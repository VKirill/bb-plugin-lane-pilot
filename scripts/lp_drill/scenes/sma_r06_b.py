"""Region 6 · Conversation and intake, batch b: the conversation engine, the backlog, the questions and the task words (docs/sma-evidence.md).

Called from sma_r06.py (three single lines). The probe (sma_r06_b_probe.ts) runs the REAL code of the commit under drill on the scratch worlds of
tests/sma/r06-world-b.ts (fake host, scratch database, temp folders, stand-in tools: no model, no hub write, nothing outside the machine); every
value is compared here with the result the node's card names and prove()d once per node. n593 is run through the real engine with a stub for its
analyst: the model step itself is not exercised. n557 (batch from a phrase) and n564 (phase boundaries) are open, not proved here.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT

NODES_B = ["n559", "n561", "n562", "n563", "n565", "n566", "n567", "n568", "n569", "n570", "n571", "n574", "n575", "n576", "n577", "n578", "n579",
           "n580", "n581", "n582", "n583", "n584", "n585", "n586", "n587", "n588", "n589", "n590", "n591", "n592", "n593", "n594", "n595"]
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r06_b_probe.ts"


def prove_b(proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the plugin's rooms, whose barrel files tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_B:
            proofs.prove(node, False, f"the batch-b probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-200:]}")
        return

    # n559 A second «да» to the same proposal does not enqueue a second task: one start per key, a repeat is answered with that start.
    h = s["handOver"]
    ok = [row["requestId"] for row in h["starts"]] == ["lead:road1", "lead:road2"] and h["one"] == h["two"] == h["three"] == {"started": True, "via": "issue-quick", "id": "wf_1"}
    proofs.prove("n559", ok, f"graph starts {[row['requestId'] for row in h['starts']]} for three hand-overs of one key and one of another; repeats answered {h['three']}")

    # n561 The line under the input follows owner.words and shows in PM chats only.
    b = s["boundary"]
    ok = b == {"pmOn": "composerBoundary", "pmRisky": "composerBoundaryRisky", "pmSensitive": "composerBoundarySensitive", "pmUnset": "composerBoundarySensitive", "pmOff": None,
               "writer": None, "helper": None, "none": None}
    proofs.prove("n561", ok, f"PM chat: on -> {b['pmOn']}, sensitive -> {b['pmSensitive']}, off -> {b['pmOff']}; a writer chat -> {b['writer']}")

    # n562 The model's answer passes a shape check before a person sees it: a task contract is refused or linted before any row exists.
    v = s["validate"]
    ok = v["missingRefused"] and v["goodOk"] and "output_unowned" in v["outsideCodes"] and "output_unowned" not in v["insideCodes"] and "output_never_touch" in v["neverCodes"]
    proofs.prove("n562", ok, f"a contract without owns_paths refused={v['missingRefused']}; an output outside owns_paths -> {v['outsideCodes']}, inside -> {v['insideCodes']}, in never_touch -> {v['neverCodes']}")

    # n563 Outside the queue: no seat, copy or receipt; spend booked under the PM thread's own id.
    sp = s["spendBooked"]
    ok = sp == {"cursors": ["thr_pm"], "cursorTotal": 14, "daily": [{"project_id": "projA", "total_tokens": 14}], "attempts": 0, "receipts": 0}
    proofs.prove("n563", ok, f"cursor rows {sp['cursors']} total {sp['cursorTotal']}, open attempts {sp['attempts']}, receipts {sp['receipts']}")

    # n565 / n566 / n571 What the activation spawns.
    a = s["activation"]
    ok = a["spawnProvider"] == "pm-prov" and a["spawnModel"] == "pm-model" and a["sources"]["providerId"] == "explicit" and a["sources"]["model"] == "explicit" and a["pmRow"]["pm_thread_id"] == "pm-main"
    proofs.prove("n565", ok, f"the PM spawned on provider {a['spawnProvider']} model {a['spawnModel']} (the writer's is wr-prov), inputs {a['sources']['providerId']}/{a['sources']['model']}")
    ok = a["userOk"] and a["writerError"] == "Lane Pilot writer threads cannot activate a PM" and a["writerSpawns"] == 0 and a["metadata"]["role"] == "pm"
    proofs.prove("n566", ok, f"an ordinary chat enables a PM (role {a['metadata']['role']}); a writer thread -> {a['writerError']!r}, spawns {a['writerSpawns']}")
    ok = a["boundTools"] and a["boundPersist"] == "dev-orchestrator" and a["plainHasBinding"] is False and a["missingError"] and a["missingSpawns"] == 0 and a["runsBefore"] == a["runsAfter"] == 0
    proofs.prove("n571", ok, f"the compiled profile {a['boundPersist']} rode the spawn with its tools={a['boundTools']}; without the capability the spawn stopped before a run row (runs {a['runsAfter']}, spawns {a['missingSpawns']})")

    # n567 / n574 The turn watch under the owner's limits.
    w = s["turnWatch"]
    ok = (w["stoppedAtThree"] == [] and w["cutAtFour"] == {"stopped": ["thr_pm"], "outcome": "предел ходов: 3"} and w["sameTurn"] == ["thr_pm"]
          and w["nextAtFive"] == [] and w["nextAtSix"] == {"stopped": ["thr_pm"], "outcome": "предел ходов: 5"} and w["writerOpen"])
    proofs.prove("n567", ok, f"cap 3: cut at item 4 -> {w['cutAtFour']['outcome']!r}; the cap changed to 5 mid-turn did not move that turn, the next turn cut at its 6th item -> {w['nextAtSix']['outcome']!r}")
    ok = w["at3"] == [] and w["at5"] == ["thr_pm"] and w["timedStops"] == ["timed:thr_pm"] and w["named"] == ["ход не уложился в 4 минут", "пустой ответ", "отказ вендора: quota exceeded", "отказ вендора: model overloaded"] and w["spoke"]
    proofs.prove("n574", ok, f"4-minute limit: nothing at 3 min {w['at3']}, cut at 5 min {w['at5']}; named: {w['named']}")

    # n568 The prompt of a resumed PM session carries the run's board and the phase rubric.
    bb = s["boardBlock"]
    ok = bb["block"].startswith("Board now:\nTasks: ") and bb["tasks"] == ["t1 accepted", "t2 ?"] and bb["none"] is None and bb["withPhase"]["block"] == f"Board now:\nPhase {bb['withPhase']['id']} — discussion. {bb['withPhase']['rubric']}"
    proofs.prove("n568", ok, f"board tasks {bb['tasks']}; with a live phase it starts {bb['withPhase']['block'][:70]!r}; an unknown run -> {bb['none']}")

    # n569 Reads only through the granted reader, never a root of its own choosing.
    r = s["read"]
    ok = list(r["errors"].values()) == ["lane_pilot_read_path_escaped_workspace"] * 4 and r["callsAfterRefusals"] == 0 and r["ok"] == "read" and r["firstCall"]["projectCwd"] == "/work/proj" and r["writer"] == "caller is not a Lane Pilot PM thread" and r["callsTotal"] == 1
    proofs.prove("n569", ok, f"absolute, .., nested .. and NUL paths -> {set(r['errors'].values())}, host reads before the good path {r['callsAfterRefusals']}, root {r['firstCall']['projectCwd']}, a writer caller -> {r['writer']!r}")

    # n570 The board observation reads only the caller's own run.
    bs = s["boardScope"]
    ok = bs == {"aRun": "runA", "aTasks": ["ta"], "bRun": "runB", "bTasks": ["tb"], "noneTasks": [], "kind": "board"}
    proofs.prove("n570", ok, f"thread A sees {bs['aTasks']} of {bs['aRun']}, thread B {bs['bTasks']}, an unknown thread {bs['noneTasks']}")

    # n575 Spend booked under the actual model; the mismatch is named.
    sm = s["spendModel"]
    ok = sm["fallback"] == {"models": ["sonnet:14"], "day": ["sonnet"], "mismatches": ["opus->sonnet:14"]} and sm["plain"]["mismatches"] == []
    proofs.prove("n575", ok, f"a turn chosen on opus that ran on sonnet is booked {sm['fallback']['models']} and named {sm['fallback']['mismatches']}; without a fallback {sm['plain']['mismatches']}")

    # n576 Fresh data first, the age labelled.
    sc = s["scan"]
    ok = sc["fetchFirst"] and sc["fetched"] is True and sc["behind"] == 3 and sc["issuable"] == ["x1"] and sc["readAtFresh"] and sc["failedFetched"] is False and sc["failedBehind"] is None and sc["failedStillRead"] == ["x1"]
    proofs.prove("n576", ok, f"fetch before read {sc['fetchFirst']}, behind {sc['behind']}, read at fresh time {sc['readAtFresh']}; a failed fetch -> fetched {sc['failedFetched']}, board still {sc['failedStillRead']}")

    # n577 Lines only under the heading; never throws.
    pa = s["parse"]
    ok = pa["junk"] == [] and pa["thrown"] is False and pa["noId"] == 0 and pa["afterNoise"] == ["a"] and pa["two"] == ["a:ready", "b:open"]
    proofs.prove("n577", ok, f"broken output -> {pa['junk']} (threw {pa['thrown']}); lines before the marker ignored -> {pa['afterNoise']}; two items {pa['two']}")

    # n578-n583 The line's verdict, the reasons, the task message, the queue order.
    ru = s["rules"]
    ok = ru["issuable"] == ["1", "5"]
    proofs.prove("n578", ok, f"ready lines issuable (13 points and a done dependency): {ru['issuable']}")
    proofs.prove("n579", ru["needsEstimate"] == ["2"] and "2" not in ru["issuable"], f"a line without an estimate is listed to estimate {ru['needsEstimate']}, not issued")
    proofs.prove("n580", ru["decompose"] == ["3"] and "3" not in ru["issuable"], f"a 14-point line is listed to decompose {ru['decompose']}, not issued")
    proofs.prove("n581", ru["blocked"] == ["4"] and "5" in ru["issuable"], f"a line with an open dependency is blocked {ru['blocked']}; one whose dependency is done is issuable")
    first = ru["message"].split("\n")
    ok = first[0] == "Lane Pilot: из беклога проекта готова к работе задача «Item 1» (1, оценка 13, приоритет high)." and ".agents/todos/items/1/AGENT.md" in first[1]
    proofs.prove("n582", ok, f"the task message: {first[0]!r}")
    proofs.prove("n583", ru["order"] == ["3", "2", "4", "1"], f"queue order high-2, high-8, medium-5, low-1 -> {ru['order']}")
    # n594 A phrase compared with the open backlog lines.
    proofs.prove("n594", ru["matches"] == ["csv-export"] and ru["noMatch"] == [], f"«починить экспорт CSV в отчётах» matches {ru['matches']} (a done line and a new logo are not); a stranger phrase {ru['noMatch']}")

    # n584 The interval is a setting; the last scan time travels through the tick.
    c = s["cadence"]
    ok = c == {"youngScanned": False, "keptStamp": True, "oldScanned": True, "newStamp": True, "hourScanned": True, "underHourScanned": False}
    proofs.prove("n584", ok, f"120-minute interval: 60 min ago -> scanned {c['youngScanned']}, 121 min ago -> scanned {c['oldScanned']} and the time written {c['newStamp']}; default hour: 61 min -> {c['hourScanned']}, 59 min -> {c['underHourScanned']}")

    # n585 The backlog is read where the planning lives.
    ho = s["home"]
    ok = ho["plain"] == {"ids": ["in-checkout"], "readFrom": "checkout"} and ho["set"] == {"ids": ["in-home"], "readFrom": "home"} and "/home/owner/plans/.agents/todos/items/1/AGENT.md" in ho["message"]
    proofs.prove("n585", ok, f"no home -> {ho['plain']}, a planning home -> {ho['set']}; the message names {ho['message'].splitlines()[1][:80]!r}")

    # n586 Close exactly that line.
    cl = s["close"]
    ok = (cl["first"] == "closed" and cl["after"] == "id: t-door\nstatus: done\nestimate: 2\n" and cl["again"] == "already" and cl["two"] == "refused" and cl["twoText"] == "status: open\nstatus: blocked\n"
          and cl["queued"] == "not_accepted" and cl["other"] == "not_issued" and cl["closedBefore"] == 0 and cl["own"] == "closed" and cl["closedAfter"] == 1)
    proofs.prove("n586", ok, f"status line -> {cl['after']!r}, a repeat {cl['again']}, two status lines {cl['two']} untouched; a queued task {cl['queued']}, a line of another PM {cl['other']}, the accepted own {cl['own']}")

    # n587 / n588 The questions: the phase book and the parked writer's QA.
    bk = s["book"]
    ok = (bk["path"] == f".agents/phases/{bk['id']}/BOOK.md" and "**question** — q1: which locale?" in bk["afterQuestion"] and "**answer**" not in bk["afterQuestion"]
          and "**answer** — q1: ru" in bk["book"] and bk["answered"] == ["q1:ru:owner"])
    proofs.prove("n587", ok, f"written to {bk['path']}: the question line, then the answer line «q1: ru»; answered {bk['answered']}")
    q = s["parkedQa"]
    ok = (q["home1"] is True and "Q (writer): which locale?\nA: open — the writer is parked here\n" in q["open"] and "A (PM): ru\n" in q["answered"]
          and q["oldPaths"] == ["/.agents/plans/items/t-old/QA.md", "/.agents/plans/items/t-old2/QA.md"])
    proofs.prove("n588", ok, f"a parked writer's entry in the attempt QA.md: 'A: open — the writer is parked here', the answer appended 'A (PM): ru'; an old-layout task wrote {q['oldPaths'][0]}")

    # n589 / n591 The five kinds and the free text by kind.
    k = s["askKinds"]
    ok = k["kinds"] == ["checkpoint", "budget", "pause", "decision", "worker"] and k["carried"] == k["kinds"] and k["defaultKind"] == "decision" and k["unknownKind"] is None
    proofs.prove("n589", ok, f"kinds {k['kinds']}, each carried unchanged, a stored payload without a kind reads as {k['defaultKind']}, an unknown kind -> {k['unknownKind']}")
    ok = k["allow"] == {"checkpoint": True, "budget": False, "pause": False, "decision": True, "worker": True} and all(k["noOptions"].values())
    proofs.prove("n591", ok, f"free text with options: {k['allow']}; with nothing to pick: {k['noOptions']}")

    # n590 A secret-shaped answer never reaches the file or the writer.
    se = s["secret"]
    ok = se["outcomes"] == ["secret_shaped_answer"] * 3 and se["leaked"] is False and se["sentBeforePlain"] == "" and se["plain"] == "sent"
    proofs.prove("n590", ok, f"a key, a token and a private key -> {set(se['outcomes'])}, text sent to the writer thread {se['sentBeforePlain']!r}; a plain answer {se['plain']}")

    # n592 A dictionary proposes a title, description and promise.
    wd = s["words"]
    ok = (wd["full"]["title"] == "Кнопка оплаты в корзине" and wd["full"]["promise"] == ["Then покупатель видел итог до оплаты"] and wd["path"] == {"title": "Починить экспорт отчётов", "description": "Второй кусок", "promise": []}
          and wd["whenThen"]["promise"] == ["When покупатель платит, then заказ закрывается"] and wd["longTitle"] == 60)
    proofs.prove("n592", ok, f"title {wd['full']['title']!r}, promise {wd['full']['promise']}; with a path in the phrase the title is {wd['path']['title']!r}; a long title cut to {wd['longTitle']}")

    # n593 Clarification by a model: the graph on its stub, through the real engine.
    cr = s["clarify"]
    ok = (cr["id"] == "lp.clarify" and cr["nodes"] == ["analyst:agent:analyst", "done:action:emit"] and cr["green"] and cr["path"] == ["analyst", "done"]
          and cr["output"] == {"questions": [{"task": "reports", "question": "в каком формате?"}]} and cr["stubbed"] == ["analyst:agent"] and cr["writesOrTasks"] == 0)
    proofs.prove("n593", ok, f"the engine ran {cr['path']} on the analyst's stub, questions out {cr['output']}, nodes that write or make tasks {cr['writesOrTasks']} (the model step itself was not run)")

    # n595 Pieces, links and a lane from one plan.
    pl = s["plan"]
    ok = pl["waves"] == {"c": 3, "a": 1, "b": 2, "d": 1, "e": 2} and pl["lanes"] == {"c": "write", "a": "write", "b": "write", "d": "docs", "e": "check"} and pl["cycWaves"] == {"x": 0, "y": 0, "z": 1}
    proofs.prove("n595", ok, f"waves from depends_on {pl['waves']}, lanes {pl['lanes']}, a cycle gets wave 0 {pl['cycWaves']}")
