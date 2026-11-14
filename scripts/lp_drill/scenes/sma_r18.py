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
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r18_probe.ts"
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
    return proofs.verdict("sma_r18", checked=len(NODES))
