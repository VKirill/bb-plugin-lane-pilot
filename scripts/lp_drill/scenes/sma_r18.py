"""Region 18 · Claude Code session hooks: the region scene (docs/sma-evidence.md, «Trace choice»).

The hooks are programs a Claude Code session runs; they write no row to the hub database. So the node-level trace is this scene. It runs the REAL session
hook of the commit under drill (src/rooms/session-hooks/cli.ts, `node --experimental-strip-types`) on real hook inputs in a scratch HOME — stdin JSON in, exit
code, stdout decision and the files it wrote out — and the TypeScript checks the hook cards name (the periodic lease take-back, the ownership diff, the
rate-limit store, the worktree registry, the protections re-arm, the memory index…) on a scratch database, through sma_r18_probe.ts. No model turn, no write to
the hub, no network. Run: scripts/lp-drill.sh --scenario sma_r18.

The hooks are installed (materializeNativeHookSession) for every native Claude Code session Lane Pilot launches — the claude-code provider; a codex, opencode or
ACP session does not run them. n1412 (windows read by BB, core) and n1415 (thread title, core) are not proved here: their code lives in bb-core.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1402", "n1403", "n1404", "n1405", "n1406", "n1407", "n1408", "n1409", "n1410", "n1411", "n1413", "n1414", "n1416", "n1417", "n1418", "n1419",
         "n1420", "n1421", "n1422", "n1423", "n1424", "n1425", "n1426", "n1427", "n1428", "n1429", "n1430", "n1431"]
NODES_B = [f"n{k}" for k in range(1432, 1464) if k != 1445]
NODES = NODES + NODES_B
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r18_probe.ts"
PROBE_B = ROOT / "scripts/lp_drill/scenes/sma_r18_b_probe.ts"
RULE_A = "- Run the vitest gate before every merge into main."
RULE_B = "- Quote the clients section's contract wording when you plan."


def scenario_sma_r18(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r18", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1402 A hook never wedges a session: five broken inputs, five exits of zero and nothing on stdout.
    proofs.prove("n1402", s["n1402"] == [[0, ""]] * 5, f"exit and stdout for garbage, empty, cut-off JSON, a list, null: {s['n1402']}")
    # n1403 SessionEnd → session-end: the dead writer loop's idle attempt is taken back by the periodic pass.
    proofs.prove("n1403", s["n1403"] == [["a1"]], f"attempts the periodic pass asked to take back: {s['n1403']}")
    # n1404 Stop → turn-diff: a stray path is named, owned and never_touch handled.
    proofs.prove("n1404", s["n1404"] == [["src/stray.ts"], [], ["src/owned/secret.ts"]], f"unowned paths: {s['n1404']}")
    # n1405 statusLine → SMA segment: the subscription-window event is stored by provider, once.
    five = s["n1405"]["stored"]
    proofs.prove("n1405", s["n1405"]["sets"] == [s["n1405"]["prefix"] + "claude-code"] and five["label"] == "five-hour" and five["status"] == "blocked" and five["resetsAtMs"] == s["n1405"]["reset"],
                 f"stored keys {s['n1405']['sets']}, window {five}")
    # n1406 Did edits leave the claim: two trees, base against HEAD.
    t = s["n1406"]
    proofs.prove("n1406", t["status"] == "ready" and t["paths"] == ["a.ts", "b.ts"] and t["unowned"] == ["b.ts"] and t["unreadStatus"] == "failed", f"committed paths {t['paths']}, stray {t['unowned']}, no base → {t['unreadStatus']}")
    # n1407 Release own claims: only unmoved live attempts are listed.
    proofs.prove("n1407", s["n1407"] == ["old-run"], f"unmoved live attempts: {s['n1407']}")
    # n1408 Drop the window lease: the unheld worktree goes, the held one stays.
    w = s["n1408"]
    proofs.prove("n1408", w == {"removed": 1, "calls": ["/wt/gone"], "open": ["/wt/held"]}, f"worktree reconcile: {w}")
    # n1409 Farewell lesson draft: the journaled file, then the payload's own list.
    f = s["n1409"]
    proofs.prove("n1409", f["status"] == 0 and f["journaled"] == "This session changed: src/journaled.ts." and f["listed"] == "This session changed: a/first.ts, b/second.ts.", f"farewell lines {f}")
    # n1410 Segment render.
    proofs.prove("n1410", s["n1410"] == ["5h 42% - 7d 18% - opus 5%", "⚠ 5h 42% - 7d 18% - opus 5%", ""], f"segments {s['n1410']}")
    # n1411 The person line prints first / is kept: restored exactly, the person's own line untouched.
    c = s["n1411"]
    proofs.prove("n1411", c["restored"] == {"model": "opus", "statusLine": {"type": "command", "command": "node /opt/my-line.js --fancy", "padding": 2}} and len(c["removed"]) == 1 and c["ownByteForByte"] is True,
                 f"settings after the cleaner {c['restored']}, own line untouched {c['ownByteForByte']}")
    # n1413 SessionStart → session-start: the briefing first on a plain start, the capsule restored below it.
    proofs.prove("n1413", s["n1413"] == {"startupHead": "Work in this project: 2 live, 1 stale; a merge into main is running.", "hasCapsule": True}, f"start text {s['n1413']}")
    # n1414 UserPromptSubmit → prompt-recall: one pointer line for the note.
    proofs.prove("n1414", s["n1414"] == {"status": 0, "pointerLine": "- [n1] First sentence names src/a.ts. (file: src/a.ts)"}, f"recall output {s['n1414']}")
    # n1416 Session model sighting: only the current model's tasks count.
    proofs.prove("n1416", s["n1416"] == {"forB": 1, "forA": 5}, f"calibration task counts per model {s['n1416']}")
    # n1417 Sessions, collisions, push: the brief line.
    proofs.prove("n1417", s["n1417"] == "Work in this project: 2 live, 1 stale; a merge into main is running.", f"brief line {s['n1417']!r}")
    # n1418 Memory before the first act: accepted PM rules reach the prompt, the section's rule only for that section.
    proofs.prove("n1418", s["n1418"] == {"plain": [RULE_A], "clients": [RULE_A, RULE_B]} or s["n1418"] == {"plain": [RULE_A], "clients": [RULE_B, RULE_A]}, f"PM rules block {s['n1418']}")
    # n1419 What changed since last time: a weakly calibrated area.
    proofs.prove("n1419", s["n1419"] == {"weak": ["ui"], "none": []}, f"weak areas {s['n1419']}")
    # n1420 Guard of disabled protections: the expired disarm returns to the warning level once.
    proofs.prove("n1420", s["n1420"] == {"rearmed": ["code_critique.mode"], "again": []}, f"re-armed protections {s['n1420']}")
    # n1421 Weekly digest rebuild: 2 then 3, the old miss absent.
    proofs.prove("n1421", s["n1421"] == {"two": 2, "three": 3, "ancient": False}, f"miss counts {s['n1421']}")
    # n1422 MEMORY.md budget line.
    proofs.prove("n1422", s["n1422"] == {"mid": "MEMORY.md: 100/200 lines", "full": "MEMORY.md: 180/200 lines — near the limit: merge or trim entries"}, f"budget lines {s['n1422']}")
    # n1423 Capsule restored after compaction: first on a compact start.
    proofs.prove("n1423", s["n1423"] == {"compactHead": "Capsule restored after compaction:", "briefingAfterCapsule": True}, f"compact start {s['n1423']}")
    # n1424 Context at session start: nothing when there is nothing to say.
    proofs.prove("n1424", s["n1424"] == {"quietStdout": "", "quietStatus": 0, "spoken": "SessionStart"}, f"quiet start {s['n1424']}")
    # n1425 Heal a stale index: found by its words at once.
    proofs.prove("n1425", s["n1425"] == ["The zorblax reconciler prunes stale lease rows hourly"], f"search hits {s['n1425']}")
    # n1426 Search by the prompt words: the masked words are the value of --query.
    proofs.prove("n1426", s["n1426"] == {"queryFlag": "--query", "masked": True, "words": True}, f"recall arguments {s['n1426']}")
    # n1427 Never repeat what was given: the second identical prompt is silent.
    proofs.prove("n1427", s["n1427"] == {"first": True, "second": ""}, f"first/second output {s['n1427']}")
    # n1428 Pointers beside the prompt: claim and file, never the body.
    proofs.prove("n1428", s["n1428"] == {"claimAndFile": "- [n1] First sentence names src/a.ts. (file: src/a.ts)", "bodyShown": False}, f"pointer {s['n1428']}")
    # n1429 PreToolUse Task → pretask-pack: rules, claims and lessons in the prompt.
    proofs.prove("n1429", s["n1429"] == {"status": 0, "rules": True, "lessons": True, "claim": True}, f"pack layers {s['n1429']}")
    # n1430 PreCompact → precompact-capsule: each list in its own field.
    proofs.prove("n1430", s["n1430"] == {"status": 0, "stdout": "", "asks": ["keep the contract"], "files": ["src/touched.ts"], "claims": ["src/claimed.ts"], "trigger": "precompact"}, f"capsule {s['n1430']}")
    # n1431 SubagentStop → subagent-verify: the ghost path is named, the present one is not.
    v = s["n1431"]
    proofs.prove("n1431", v["status"] == 0 and v["missing"] == ["missing/ghost.ts"] and "phantoms (named but nowhere in the tree): missing/ghost.ts" in v["text"], f"verify text {v['text']!r}, receipt missing {v['missing']}")
    prove_batch_b(proofs, probe_batch_b())
    return proofs.verdict("sma_r18", checked=len(NODES))


def probe_batch_b() -> dict:
    """Batch b: the real session hook and the real Python guard on real hook inputs (sma_r18_b_probe.ts), observed values only."""
    done = subprocess.run(["npx", "tsx", str(PROBE_B)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        return json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": f"the batch b probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"}


def prove_batch_b(proofs: Proofs, b: dict) -> None:
    """Nodes n1432 … n1463 (n1445 is void). Each value below is what the card says the hook does; the probe only observed it."""
    if "error" in b:
        for node in NODES_B:
            proofs.prove(node, False, b["error"])
        return
    g = b.get
    # n1432 Worker compaction: the launcher's copy registers PreCompact and its hook writes the capsule.
    proofs.prove("n1432", g("n1432") == {"registered": True, "status": 0, "asks": ["keep this"], "files": ["src/w.ts"], "trigger": "precompact"}, f"worker copy {g('n1432')}")
    # n1433 Spend cap on subagents.
    c = g("n1433") or {}
    cap_text = f"[spend-cap] the «five-hour» window is at 95% and the cap is 90% (usage.skip_percent, set by a person): no subagent until it resets at {c.get('resets')}."
    proofs.prove("n1433", c.get("decision") == "deny" and cap_text in c.get("reason", "") and "usage.skip_percent=0" in c.get("reason", "") and c.get("freeDecision") is None and c.get("freePacked") is True,
                 f"cap {c.get('decision')}: {c.get('reason', '')[:120]}; no human cap -> {c.get('freeDecision')}")
    # n1434 Assemble the context pack.
    k = g("n1434") or {}
    head = f"Go\n\n[context pack] Repository {k.get('cwd')}. Files this window claims: a.ts, b.ts, c.ts."
    tail = " Report the files you changed by path at the end."
    proofs.prove("n1434", k.get("packed") == f"{head} Rules: r one | r two | r three. Lessons: l one.{tail}" and k.get("kept") == f"{head}{tail}", f"pack {k.get('packed')!r}")
    # n1435 Spawn records.
    r = g("n1435") or {}
    proofs.prove("n1435", r.get("kind") == "Explore" and r.get("deny") is None and r.get("chars") == r.get("packChars") and r.get("layers") == {"rules": 3, "lessons": 1, "claims": 3} and r.get("trimmed") is False and r.get("ranked") == 7 and r.get("msIsNumber") is True, f"record {r}")
    # n1436 Pack sewn into the prompt.
    i = g("n1436") or {}
    proofs.prove("n1436", i.get("subagent_type") == "Explore" and i.get("description") == "map callers" and i.get("additionalContext") is None and i.get("startsWith") is True and i.get("alreadyPackedStdout") == "", f"updatedInput {i}")
    # n1437 Claimed writes from the transcript.
    proofs.prove("n1437", g("n1437") == ["src/a.ts", "docs/b.md", "README.md"], f"claimed paths {g('n1437')}")
    # n1438 Check against the real tree.
    t = g("n1438") or {}
    proofs.prove("n1438", t.get("states") == [{"path": "src/old.ts", "state": "untouched"}, {"path": "src/dirty.ts", "state": "dirty"}, {"path": "src/new.ts", "state": "committed"}, {"path": "src/ghost.ts", "state": "phantom"}], f"states {t.get('states')}")
    # n1439 Receipt into the shared journal.
    rc = g("n1439") or {}
    proofs.prove("n1439", rc.get("afterOne") == 1 and rc.get("rows") == [{"claimed": ["a/x.ts", "a/y.ts"], "missing": ["a/y.ts"]}] * 2 and rc.get("farewell") == "Subagents: 2, unverified: a/y.ts.", f"receipts {rc}")
    # n1440 Flight capsule.
    cap = g("n1440") or {}
    proofs.prove("n1440", cap == {"taskIsPrompt": True, "constraints": ["owns_paths: src/gate/**", "- never touch the lockfile"], "decisions": ["We decided to keep the hook in TypeScript instead of Python. More follows."]}, f"capsule {cap}")
    # n1441 Worker progress summary.
    proofs.prove("n1441", g("n1441") == {"session": "cp1", "files": 1, "asks": 1, "touched": ["src/a.ts"], "commands": ["npm test", "git status"]}, f"progress row {g('n1441')}")
    # n1442 PreToolUse → pre: the six streams in order, the airbag's advice before the reflex's.
    proofs.prove("n1442", g("n1442") == {"code": 0, "heads": ["[git-airbag]", "[reflex] che"], "streams": ["deps", "git_airbag", "reflexes", "file_card", "spend", "claims"]}, f"guard run {g('n1442')}")
    # n1443 PostToolUse → stall-check.
    st = g("n1443") or {}
    proofs.prove("n1443", st.get("status") == 0 and st.get("failedHint", "").startswith("[lane-stall class] the same failing call twice (Bash).") and st.get("hasDecision") is False and st.get("okExit0") == "" and st.get("zeroFailed") == "" and st.get("traceback") == "[lane-stall class]" and st.get("third") == "[lane-stall] Same Bash result 3 times.", f"stall hints {st}")
    # n1444 Worker dangerous-call parking.
    d = g("n1444") or {}
    proofs.prove("n1444", d == {"categories": ["worker_clean_force", "worker_curl_sh", "worker_publish", "worker_reset_hard"], "grantedParked": False, "againParked": True, "plainParked": False}, f"permit tickets {d}")
    # n1446 Shared context per call.
    proofs.prove("n1446", g("n1446") == {"sA": [2], "sB": [1], "slash": [1], "dots": [1]}, f"fingerprint counts per session folder {g('n1446')}")
    # n1447 Streams in order, a failing one costs nothing.
    proofs.prove("n1447", g("n1447") == ['[null, ["[calm] still here"]]', "raised"], f"streams with a raising advice stream, then a raising required one {g('n1447')}")
    # n1448 Soft budget.
    bd = g("n1448") or {}
    proofs.prove("n1448", bd == {"skipped": ["reflexes", "file_card", "spend", "claims"], "airbagError": None, "airbagRef": True, "roomyErrors": 0}, f"budget 0: {bd}")
    # n1449 Merged into one answer.
    proofs.prove("n1449", g("n1449") == [[None, ["[downgraded] stop it", "[spend] x"]], ["stop it", ["[spend] y"]]], f"merge {g('n1449')}")
    # n1450 Stream timings.
    pf = g("n1450") or {}
    proofs.prove("n1450", pf == {"streams": ["deps", "spend", "claims"], "eachNearTwoTenths": True, "keptLines": 506}, f"perf rows {pf}")
    # n1451 Rule ladder overlay.
    lad = g("n1451") or {}
    proofs.prove("n1451", lad == {"latest": {"tier": "soft-deny", "movedAt": 2000}, "unknownWord": "note", "noEvent": {"tier": "note", "movedAt": None}, "otherProject": "auto-fix"}, f"tiers {lad}")
    # n1452 Stream: claim collision.
    cl = g("n1452") or {}
    proofs.prove("n1452", cl.get("first") == "" and cl.get("secondDenied") is False and cl.get("second", "").endswith("is also being edited by sessA (writer) in the last 30 minutes: coordinate, or touch another file.") and cl.get("repeated") == "" and cl.get("oldClaim") == "", f"claims advice {cl.get('second')!r}")
    # n1453 Stream: reflexes from lessons.
    rf = g("n1453") or {}
    proofs.prove("n1453", rf.get("lines") == ["- WHEN prisma migrate -> run it on a copy first"] and rf.get("fires") == ["[reflex] run it on a copy first", "[reflex] run it on a copy first", ""] and rf.get("other") == "", f"reflex {rf.get('fires')}")
    # n1454 Stream: checkable hard rules.
    gt = g("n1454") or {}
    proofs.prove("n1454", gt == {"warn": {"warnings": ["no console.log in src"], "blocks": []}, "block": {"warnings": [], "blocks": ["no console.log in src"]}, "outside": {"warnings": [], "blocks": []}, "notAdded": {"warnings": [], "blocks": []}}, f"gates {gt}")
    # n1455 Stream: git airbag.
    ab = g("n1455") or {}
    proofs.prove("n1455", ab.get("code") == 0 and ab.get("statusRefs") == "" and ab.get("statusStdout") == "" and ab.get("saved") == "unsaved work\n" and ab.get("advice", "").startswith(ab.get("expectedAdvicePrefix", "?")) and ab.get("advice", "").endswith(" -- . brings it back"), f"airbag {ab.get('advice')!r}")
    # n1456 Stream: dependency store.
    dp = g("n1456") or {}
    proofs.prove("n1456", dp == {"install": True, "remove": True, "unlink": False, "copy": False}, f"deps guard {dp}")
    # n1457 Stream: window work fingerprint.
    fp = g("n1457") or {}
    proofs.prove("n1457", fp == {"branch": "feature/x", "paths": 50, "first": "src/file0.ts", "dead": {"branch": None, "paths": []}}, f"fingerprint {fp}")
    # n1458 Stream: enforcing foreign claims.
    proofs.prove("n1458", g("n1458") == ["idle-cancel", "idle-running"], f"live attempts unmoved past the cutoff {g('n1458')}")
    # n1459 Stream: knowledge at the act.
    kn = g("n1459") or {}
    proofs.prove("n1459", kn.get("head") == "# File notes||src/a.ts -> generated file, edit the template" and kn.get("secretKept") is False and kn.get("notes") == ["[file-note] generated file, edit the template", "[file-note] generated file, edit the template", "", ""], f"file notes {kn}")
    # n1460 Stream: spend and rule loops.
    sp = g("n1460") or {}
    proofs.prove("n1460", sp == {"low": "", "at72": "[spend] five-hour is at 72%", "at72again": "", "at92": "[spend] five-hour is at 92%", "at92again": "", "other": "[spend] five-hour is at 92%"}, f"spend warnings {sp}")
    # n1461 Window of recent events.
    proofs.prove("n1461", g("n1461") == {"recentIsLastEight": True, "length": 8}, f"stall trail {g('n1461')}")
    # n1462 Four stall rules.
    sr = g("n1462") or {}
    proofs.prove("n1462", sr.get("silentSeven") is True and sr.get("eighth", "").startswith("[lane-stall] eight read-only calls in a row") and sr.get("pingpong", "").startswith("[lane-stall] you are alternating between two calls") and sr.get("silentBeforePingpong") is True and sr.get("identical", "").startswith("[lane-stall] Identical Grep result has already been returned 3 times."), f"rules {sr}")
    # n1463 Advice to break the loop: once per pattern.
    nd = g("n1463") or {}
    proofs.prove("n1463", nd == {"a": [False, False, True], "fourth": False, "fifth": False, "b": [False, False, True], "nudged": 2}, f"nudges {nd}")
