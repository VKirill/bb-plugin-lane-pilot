"""Region 8 · Daemon front outside the graphs, batch b (n704 … n754) — proofs of the region scene sma_r08 (docs/sma-evidence.md, «Trace choice»).

None of these nodes writes a hub table row, so each is proved here. The probe (sma_r08_b_probe.ts, run by vite-node) boots the REAL functions of the commit
under drill in the worlds of tests/sma/r08-world-b.ts (a fake plugin host that records every host call, scratch databases, temp git repositories, a fixture
release tree, a stand-in bb, the real terminal guard) and prints the values; this module compares each with the card's expected result and prove()s it.
No model, no hub write, nothing outside the machine. n745 and n746 are deviations (memory lives only on the hub) and n751 waits for a live model scene:
they are not here. Run: scripts/lp-drill.sh --scenario sma_r08 (this module adds its nodes to that scene).
"""
from __future__ import annotations

import json
import os
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_B = ["n704", "n705", "n706", "n713", "n714", "n715", "n716", "n717", "n718", "n719", "n720", "n721", "n722", "n726", "n727", "n729", "n730", "n731", "n732",
           "n733", "n734", "n735", "n736", "n737", "n738", "n739", "n740", "n741", "n742", "n743", "n747", "n748", "n749", "n750", "n753", "n754"]
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r08_b_probe.ts"
# Held under LP_DRILL_SMA_PRIMARY_ONLY=1: the probe never calls the «worktree» world (codeTreeWorktree: real gitCreateWorktree/integrateWorktree);
# its node is never proved. sma_r08.py takes the same dict for notProved and the checked count.
PRIMARY_ONLY_HELD_B = {"n729": "PRIMARY-only hold: world codeTreeWorktree creates real scratch git worktrees (tests/sma/r08-world-b.ts)"}


def held_b() -> dict[str, str]:
    """The batch-b nodes held in this run: PRIMARY_ONLY_HELD_B under LP_DRILL_SMA_PRIMARY_ONLY=1, none otherwise."""
    return dict(PRIMARY_ONLY_HELD_B) if os.environ.get("LP_DRILL_SMA_PRIMARY_ONLY") == "1" else {}


def _bad(s: dict, *names: str) -> str | None:
    return next((f"{name}: {s[name]['error']}" for name in names if isinstance(s.get(name), dict) and "error" in s[name]), None)


def prove_b(proofs: Proofs, tmp) -> None:
    # vite-node, not tsx: the probe loads the whole plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in (n for n in NODES_B if n not in held_b()):
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return

    held = held_b()

    def check(node: str, names: tuple[str, ...], ok, detail) -> None:
        if node in held:
            return
        error = _bad(s, *names)
        if error:
            proofs.prove(node, False, f"the probe's world threw: {error}")
            return
        proofs.prove(node, bool(ok()), detail())

    # n704 The hub's view of its peers: each BB-listed machine is a snapshot with name, answered or not, last-seen kept while off; no address or token.
    def peers():
        p = s["peers"]
        by = lambda rows: {row["hostId"]: row for row in rows}
        return (by(p["first"])["h1"]["name"] == "Big" and by(p["first"])["h1"]["online"] and by(p["first"])["h1"]["lastOnlineAt"] == p["t0"] - 600000 and by(p["first"])["h1"]["answered"] is True
                and by(p["first"])["h2"]["online"] is False and by(p["first"])["h2"]["lastOnlineAt"] is None and by(p["third"])["h2"]["lastOnlineAt"] == p["t0"] - 300000
                and by(p["third"])["h2"]["online"] is False and p["leaks"] == [])
    check("n704", ("peers",), peers, lambda: f"h1 {s['peers']['first'][1]['online']} named {s['peers']['first'][1]['name']}, h2 off keeps last-seen {s['peers']['third'][0]['lastOnlineAt'] - s['peers']['t0']} ms from now; leaks {s['peers']['leaks']}")
    # n705 Peers polled with every board: a failing peer is marked unanswered, silence is unanswered, the others still answer, an off machine is not asked.
    def poll():
        b = s["pollBoards"]["by"]
        return (b["h1"]["answered"] is True and b["h1"]["windows"] == {"windows": {"five_hour": {"utilization": 12}}} and b["h2"]["answered"] is False and b["h3"]["answered"] is False
                and b["h4"] == {"online": False, "answered": None, "windows": None} and s["pollBoards"]["ids"] == ["h1", "h2", "h3", "h4"])
    check("n705", ("pollBoards",), poll, lambda: f"answered: {[(k, v['answered']) for k, v in sorted(s['pollBoards']['by'].items())]}")
    # n706 Last snapshot of a peer: memory only — a machine BB no longer lists is forgotten, an empty list drops nothing, a restarted front starts with none.
    m = s.get("snapshotMemory", {})
    check("n706", ("snapshotMemory",), lambda: m["afterLeave"] == ["h1"] and m["afterEmpty"] == ["h1"] and m["restarted"] == [], lambda: f"after a host left {m.get('afterLeave')}, after an empty list {m.get('afterEmpty')}, restarted front {m.get('restarted')}")
    # n713 Repeat an action on a peer: the same request to that machine, its answer relayed as it is, its refusal not swallowed.
    r = s.get("relay", {})
    check("n713", ("relay",), lambda: r["answer"] == {"hostId": "mac-2", "exitCode": 7, "stdout": "out\n", "stderr": "warn: x\n"} and r["target"] == "mac-2" and r["route"] == {"hostId": "mac-2", "timeoutMs": 8000} and r["thrown"] == "peer door refused",
          lambda: f"answer {r.get('answer')} via {r.get('route')}, refusal {r.get('thrown')!r}")
    # n714 Three proxyable paths: a closed list of host methods, no owner word among them.
    pl = s.get("peerList", {})
    check("n714", ("peerList",), lambda: pl["count"] == 75 and pl["hasJobs"] and pl["hasRun"] and pl["hasOwnsBarrier"] and pl["wordsOnPeers"] == [], lambda: f"{pl.get('count')} peer methods, owns barrier: {pl.get('hasOwnsBarrier')}, owner's word calls among them: {pl.get('wordsOnPeers')}")
    # n715 Machines: presence only — the lines say who, on or off, the board; no address or token.
    def read():
        lines = {row["hostId"]: row["line"] for row in s["peers"]["listed"]}
        return (lines["h1"] == "Big: на связи · окна: five_hour 40% · проекты: — · сегодня: принято 0, стоит 0, идёт 0"
                and lines["h2"] == "Mini: не отвечает (last seen 5 min ago) · проекты: — · сегодня: принято 0, стоит 0, идёт 0" and s["peers"]["leaks"] == [])
    check("n715", ("peers",), read, lambda: f"lines {[row['line'] for row in s['peers']['listed']]}")
    # n716 First-run interview: the four questions in order, an empty draft with no stored cursor, the next question derived from the answers.
    i = s.get("interview", {})
    check("n716", ("interview",), lambda: i["stepIds"] == ["goal", "writer", "quality", "words"] and i["neededFresh"] and i["draftKeys"] == ["answers", "at", "projectId"] and i["answersFresh"] == {}
          and i["answersLater"] == {"goal": "Track parcels for the shop", "writer": "codex / gpt-6-luna"} and i["next"] == "quality", lambda: f"steps {i.get('stepIds')}, draft keys {i.get('draftKeys')}, next {i.get('next')}")
    # n717 Four question steps: project, who writes, how strict, how the owner takes part — each tied to its setting.
    check("n717", ("interview",), lambda: i["stepSettings"] == [None, "writer", "quality_mode", "owner.words"] and len(i["questions"]) == 4 and "(sensitive, the default)" in i["questions"][3], lambda: f"settings {i.get('stepSettings')}")
    # n718 Answers draft: trimmed, capped at 2000, earlier answers kept, found by a restarted front.
    d = s.get("draft", {})
    check("n718", ("draft",), lambda: d["goal"] == "Ship the parcel tracker" and d["writer"] == "codex / gpt-6-luna" and d["longLength"] == 2000 and d["qualityLength"] == 2000 and d["stored"] == ["goal", "quality", "writer"],
          lambda: f"goal {d.get('goal')!r}, writer {d.get('writer')!r}, long answer {d.get('longLength')} chars, kept {d.get('stored')}")
    # n719 No secret reaches the draft: refused with the reason before anything is stored.
    sc = s.get("secret", {})
    check("n719", ("secret",), lambda: sc["refused"] == "this answer looks like a key or a password: it is not kept; save secrets in Env Catalog and answer with their name" and sc["storedAfterRefusal"] is None and sc["answersAfterRefusal"] == {}
          and sc["plain"] == {"goal": "Key lives in Env Catalog as STRIPE_KEY"}, lambda: f"refused {sc.get('refused')!r}; stored after refusal {sc.get('storedAfterRefusal')}; plain answer kept {sc.get('plain')}")
    # n720 Is a first run needed: while no writer is chosen and it was never finished — and not after either.
    nd = s.get("needed", {})
    check("n720", ("needed",), lambda: nd == {"fresh": True, "emptyDraft": True, "writerSet": False, "legacyWriter": False, "finished": False}, lambda: f"{nd}")
    # n721 One profile writer: finishing writes writer, strictness, owner.words (sensitive by default) and the goal, then the interview is no longer needed.
    f = s.get("finish", {})
    check("n721", ("finish",), lambda: f["finished"] == {"written": ["writer.provider", "writer.model", "quality_mode", "owner.words"], "goal": True}
          and f["settings"] == {"provider": "codex", "model": "gpt-6-luna", "quality": "full", "words": "sensitive", "goal": "Track parcels for the shop"} and f["neededBefore"] and not f["neededAfter"] and f["doneStamped"]
          and f["words"] == {"yes": "on", "risky": "risky", "money": "sensitive", "no": "off"}, lambda: f"wrote {f.get('finished')}, settings {f.get('settings')}, needed after {f.get('neededAfter')}")
    # n722 Project register: a second address is taken only when fit; an unfit stored value reads as unset and is said once.
    h = s.get("homes", {})
    check("n722", ("homes",), lambda: h["good"] == "/plans/a/b" and h["bad"] == [None] * 5 and h["warnedOnce"] == 5 and h["again"] == 5 and h["unset"] == [None] * 3, lambda: f"good {h.get('good')}, unfit {h.get('bad')}, warnings {h.get('again')}")
    # n726 Second address: planning: the planning files live under the home when valid, else the code tree.
    ro = s.get("roots", {})
    check("n726", ("roots",), lambda: ro == {"set": "/plans/p", "unset": "/w/p", "invalid": "/w/p", "none": None, "homeOnly": "/plans/p"}, lambda: f"{ro}")
    # n727 In-memory copy refreshed: a saved setting is the next read's value at once, the version moves on at each write.
    rf = s.get("refresh", {})
    check("n727", ("refresh",), lambda: rf["one"] == ["quick", 1] and rf["two"] == ["full", 2] and rf["read"] == "full" and rf["cas"] == {"ok": True, "version": 3} and rf["three"] == ["standard", 3] and rf["generation"] == 3, lambda: f"versions {rf.get('one')} -> {rf.get('two')} -> {rf.get('three')}")
    # n729 Project code tree: the worker's copy is cut from the checkout under the one worktree root and merged back into it.
    wt = s.get("worktree", {})
    check("n729", ("worktree",), lambda: wt["path"] and wt["branch"] == "lane/lpattempt_c1" and wt["cutIsHead"] and wt["olderIsOld"] and wt["merged"] == "merged" and wt["landedInTree"] == "export const f = 1;" and wt["worktreeGone"] and wt["branchGone"],
          lambda: f"copy at <root>/app/<id> on {wt.get('branch')}, at head {wt.get('cutIsHead')}, merged {wt.get('merged')}, file in the code tree {wt.get('landedInTree')!r}, copy and branch gone {wt.get('worktreeGone')}/{wt.get('branchGone')}")
    # n730 Project planning home: roadmap and requirements under .agents/planning; with a home set the same paths point into it; without one byte for byte.
    ht = s.get("homeText", {})
    check("n730", ("homeText",), lambda: ht["unset"] == [".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", ".agents/phases/ph_1/DISCUSSION.md"] and ht["inHome"][0] == "/plans/g5/.agents/planning/ROADMAP.md"
          and ht["byteForByte"] and ht["items"] == ".agents/plans/items/t1/PLAN.md" and ht["allUnderAgents"], lambda: f"discussion reads {ht.get('unset')}; in a home {ht.get('inHome', [''])[0]}")
    # n731 Worker presence in words: free, waiting for named tasks, writing, checking.
    pr = s.get("presence", {})
    check("n731", ("presence",), lambda: pr == {"free": {"column": "queued", "phase": "queued", "waitingFor": []}, "waits": {"column": "queued", "phase": "waiting", "waitingFor": ["ck-1", "ck-2"]},
          "works": {"column": "running", "phase": "writing", "waitingFor": []}, "checks": {"column": "checking", "phase": "checking", "waitingFor": []}}, lambda: f"{ {k: v['phase'] for k, v in pr.items()} }")
    # n732 Board derivation: derived afresh from the ledger and the clock; a change shows at the next read; no board is stored.
    dv = s.get("derived", {})
    check("n732", ("derived",), lambda: dv["first"] == {"move": "queued/queued", "fresh": "running/retrying", "blk": "blocked/blocked", "can": "done/canceled", "acc": "done/accepted", "stuck": "blocked/stuck"}
          and dv["second"]["move"] == "running/writing" and dv["boardTables"] == [], lambda: f"first {dv.get('first')}; after the move {dv.get('second', {}).get('move')}; board tables {dv.get('boardTables')}")
    # n733 Accounts and their windows: one entry per online machine with its live windows; null with a reason where BB has no figure; no machine file read.
    ac = s.get("accounts", {})
    check("n733", ("accounts",), lambda: ac["hosts"] == ["h1", "h2"] and ac["first"]["windows"] == {"five_hour": {"utilization": 40, "resetsAt": None}} and ac["first"]["reason"] is None and ac["secondWindows"] is None and ac["secondReason"] and ac["hostCalls"] == [],
          lambda: f"entries {ac.get('hosts')}, first {ac.get('first', {}).get('windows')}, second {ac.get('secondWindows')}, host calls {ac.get('hostCalls')}")
    # n734 Rules as written: the hub's value, the project's over it, a section's over the project's.
    ly = s.get("layers", {})
    check("n734", ("layers",), lambda: ly["project"] == {"quality_mode": "full", "writer.provider": "global-writer"} and ly["inSection"] == {"quality_mode": "quick", "writer.provider": "global-writer", "owner.words": "on"}
          and ly["other"] == {"quality_mode": "standard", "writer.provider": "global-writer"}, lambda: f"project {ly.get('project')}; in a section {ly.get('inSection')}")
    # n735 Who can see the door: the public address or the hub, how it is reached, the machines' lines; no address or token.
    dr = s.get("door", {})
    check("n735", ("door",), lambda: dr["bare"] == "the BB hub" and dr["named"] == "https://hub.example.org" and dr["reachedOver"] == "WireGuard (no public bb connect)" and dr["sameAsPeers"] and dr["leaks"] == [], lambda: f"door {dr.get('bare')!r} / {dr.get('named')!r}, over {dr.get('reachedOver')!r}, leaks {dr.get('leaks')}")
    # n736 Terminal coordination: the run's checkout on the run's machine, the answer capped at 20000, the error text when it said nothing.
    co = s.get("coord", {})
    check("n736", ("coord",), lambda: co["statusCall"] == {"method": "runCommand", "input": {"requestedHostId": "h1", "command": "lane-coord status", "cwd": "/ws/p", "timeoutSec": 20}, "options": {"hostId": "h1", "timeoutMs": 25000}}
          and co["statusOutputLength"] == 20000 and co["quietOutput"] == 2000 and co["quietIsStderr"] and co["noCheckout"] == "run nope has no checkout", lambda: f"call {co.get('statusCall', {}).get('input')}, output {co.get('statusOutputLength')} chars, quiet {co.get('quietOutput')} chars")
    # n737 Terminal claim ledger: an edit claims its file; another session's fresh claim of the same file is said once; past 30 minutes it is silent; never a deny.
    cl = s.get("claims", {})
    check("n737", ("claims",), lambda: not cl["a"] and cl["b"] and not cl["bDenied"] and not cl["bAgain"] and cl["aHears"] and cl["sessions"] == ["sess-A", "sess-B"] and cl["oldSilent"] and cl["midHeard"],
          lambda: f"first editor hears nothing {not cl.get('a')}, second hears sess-A {cl.get('b')}, denied {cl.get('bDenied')}, again {cl.get('bAgain')}, book {cl.get('sessions')}, claim of 60 min silent {cl.get('oldSilent')}, of 10 min heard {cl.get('midHeard')}")
    # n738 Clear a claim with a reason: without one the call is refused; with one the command carries both, stripped of quote-breakers.
    check("n738", ("coord",), lambda: co["refused"] == {"missing": True, "empty": True, "short": True, "spaces": True, "good": True}
          and co["clearCall"]["input"]["command"] == "lane-coord force-clear 'sessAxy' --reason 'stale claim of a gone session'" and co["cleared"] == {"exitCode": 0, "output": "cleared"}, lambda: f"refused without/empty/short/blank reason {co.get('refused')}; command {co.get('clearCall', {}).get('input', {}).get('command')!r}")
    # n739 Backlog as a board: issuable by urgency then size, no estimate, above 13, waiting for an item not done.
    bl = s.get("backlog", {})
    check("n739", ("backlog",), lambda: bl == {"issuable": ["b", "a", "h", "c"], "needsEstimate": ["d"], "decompose": ["e"], "blocked": ["f", "g"]}, lambda: f"{bl}")
    # n740 Search over the sources: notes, the cold layer, past tasks and the miss in one answer.
    me = s.get("memory", {})
    check("n740", ("memory",), lambda: me["active"]["state"] == "passed" and "components/cards/share.ts" in me["active"]["context"] and me["active"]["noteStored"] and "Memory has nothing relevant" not in me["active"]["context"]
          and "Past tasks like this one (what happened):\n- refund-flow «Refund approval screen»" in me["episode"]["context"] and me["episode"]["episodes"] == 1 and "Notes from the cold tier" in me["cold"]["context"] and me["cold"]["promotedFromCold"] == 1
          and me["nothing"] == {"state": "passed", "nothingRelevant": True, "misses": ["quantum teleportation licensing"]} and me["off"]["reason"] == "memory_disabled" and me["foreign"] == "runId does not belong to this Lane Pilot PM thread",
          lambda: f"note {me.get('active', {}).get('noteStored')}, past tasks {me.get('episode', {}).get('episodes')}, cold {me.get('cold', {}).get('promotedFromCold')}, miss {me.get('nothing', {}).get('misses')}, off {me.get('off', {}).get('reason')}")
    # n741 Diagnostics without secrets: version, platform, OS release, node, unknown codes of 14 days; nothing of the environment or paths.
    dg = s.get("diag", {})
    check("n741", ("diag",), lambda: dg["keys"] == ["builtAt", "name", "node", "osRelease", "platform", "tables", "unknownCodes", "version"] and dg["unknownCodes"] == 3 and dg["platform"] and dg["node"] and dg["leaks"] == [], lambda: f"keys {dg.get('keys')}, unknown codes {dg.get('unknownCodes')} (a 20-day-old one left out), leaks {dg.get('leaks')}")
    # n742 Live event stream: a burst is one signal per thing after the window, naming only what to re-read; a bus that fails is logged once.
    st = s.get("stream", {})
    check("n742", ("stream",), lambda: st["inWindow"] == 0 and st["burst"] == [{"channel": "lp:p1", "payload": {"kind": "council", "threadId": "thr1"}}, {"channel": "lp:p1", "payload": {"kind": "rules", "threadId": "thr1"}}, {"channel": "lp:p2", "payload": {"kind": "council"}},
          {"channel": "lp:p1", "payload": {"kind": "workflow", "threadId": "thr2", "runId": "run-9"}}, {"channel": "lp:p1", "payload": {"kind": "workflow-draft", "draftId": "draft-3"}}] and st["logged"] == ["Lane Pilot realtime publish failed: bus down"],
          lambda: f"{len(st.get('burst', []))} signals after {st.get('window')} ms (none inside the window {st.get('inWindow') == 0}); log {st.get('logged')}")
    # n743 Stream frame list: a closed list of kinds; another kind or none is not taken.
    kd = s.get("kinds", {})
    check("n743", ("kinds",), lambda: kd["kinds"] == ["helpers", "council", "rules", "workflow", "workflow-draft", "schedule", "harness"] and kd["parsed"] == kd["kinds"] and kd["unknown"] is None and kd["noKind"] is None and kd["nothing"] is None
          and kd["carried"] == {"kind": "workflow", "threadId": "t1", "runId": "r1"}, lambda: f"kinds {kd.get('kinds')}, unknown kind -> {kd.get('unknown')}")
    # n747 Ship gate: the six steps in order; a clean tree passes, a promise stops at the last step with the earlier ones printed.
    g = s.get("gate", {})
    check("n747", ("gate",), lambda: g["cleanStatus"] == 0 and g["cleanLast"] == "gate: build, freshness, publishable, licenses, doc-audit and predict-lint all clean" and g["promiseStatus"] == 1 and g["promiseLast"] == "gate: predict-lint failed"
          and g["promiseOut"].index("publishable: 0.1.1") < g["promiseOut"].index("license ledger") < g["promiseOut"].index("doc honesty") < g["promiseOut"].index("gate: predict-lint failed"), lambda: f"clean exit {g.get('cleanStatus')} «{g.get('cleanLast')}»; with a promise exit {g.get('promiseStatus')} «{g.get('promiseLast')}»")
    # n748 One gate run at a time: a lock of a live process is not taken; a dead one, an empty one and a free place are.
    lk = s.get("lock", {})
    check("n748", ("lock",), lambda: lk["live"] == "False" and lk["liveStillHeldBy"] and lk["dead"] == "True" and lk["noPid"] == "True" and lk["fresh"] == "True" and lk["freshHasPid"], lambda: f"live lock taken: {lk.get('live')}, dead {lk.get('dead')}, empty {lk.get('noPid')}, free {lk.get('fresh')}")
    # n749 Project verb as a process: its own process in the project's folder; output, error text and exit code back; killed past its limit.
    vb = s.get("verb", {})
    check("n749", ("verb",), lambda: vb["hostId"] == "h9" and vb["exitCode"] == 3 and vb["ownTree"] and vb["separate"] and vb["stderr"] == "oops" and vb["slowExit"] == 1 and "killed by SIGTERM" in vb["slowStderr"]
          and vb["refused"] == "refusing host command: --apply/setup are forbidden in Mode 2", lambda: f"exit {vb.get('exitCode')} in {vb.get('where')}, error text {vb.get('stderr')!r}, slow command exit {vb.get('slowExit')} ({vb.get('slowStderr')!r})")
    # n750 Gate receipt: publishing needs the receipt of a green full run on disk for this tree and node version.
    rc = s.get("receipt", {})
    check("n750", ("receipt",), lambda: rc["withReceipt"] == [0, "publishable: 0.1.1"] and rc["without"] == [1, True] and rc["otherNode"] == [1, True] and rc["changedTree"] == [1, True] and rc["restamped"] == [0, "publishable: 0.1.1"] and rc["onDisk"],
          lambda: f"with receipt {rc.get('withReceipt')}, without {rc.get('without')}, other node version {rc.get('otherNode')}, changed tree {rc.get('changedTree')}, stamped again {rc.get('restamped')}")
    # n753 Downgrade refused: an installed guard that differs from the bundled one is left untouched; an absent one is placed.
    dg = s.get("downgrade", {})
    check("n753", ("downgrade",), lambda: dg["kept"] == "# a newer guard, not the bundled one\n" and dg["placedHasGuard"], lambda: f"newer guard on disk kept {dg.get('kept')!r}; absent one placed {dg.get('placedHasGuard')}")
    # n754 The installer the same way: only on the owner's yes, on the project's machine; the receipt kept; a refusing machine leaves the last receipt.
    ins = s.get("installer", {})
    check("n754", ("installer",), lambda: ins["blockedStatus"] == "blocked" and ins["receiptBlocked"] is None and ins["installsAfterBlock"] == 0 and ins["saved"] == ins["ok"] and ins["installs"] == ["host-i", "host-i"] and ins["failed"] == "machine refused the install"
          and ins["keptSame"] and ins["unbound"] == "Lane Pilot prototype is not configured for this project", lambda: f"without yes {ins.get('blockedStatus')} (installs {ins.get('installsAfterBlock')}), with yes {ins.get('ok', {}).get('status')}, refusing machine {ins.get('failed')!r}, last receipt kept {ins.get('keptSame')}")
