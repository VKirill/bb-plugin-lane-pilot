"""Region 20 · Terminal coordination: the region scene (docs/sma-evidence.md, «Trace choice»).

Several terminals working in one project is Lane Pilot's checkout and ownership layer: a window is a checkout-guest lease in the plugin's kv, it announces
named claims of file globs (advisory, with collisions shown against open tasks' owns_paths), releases them with a record, and the owner can force-clear a
foreign claim with a reason; windows ask each other through the relay; every task gets its own git copy, copies are merged into main one at a time and a
copy can take main in. These checks write no row to the hub database (kv, git, a webhook, a migration list), so the node-level trace is this scene.

Every node is checked with TWO actors against one scratch state (the second is refused, waits, or sees the first one's claim; the claim is gone after
release). The probe sma_r20_probe.ts drives the REAL code of the commit under drill on the fake plugin host, temporary git repositories and a stand-in
fetch: no model turn, no hub write. Run: scripts/lp-drill.sh --scenario sma_r20.

n1533 (sma open) is core-resident (core:apps/server/src/services/plugins/vk-owner-auth.ts#mintVkOwnerSessionCookie) and is not proved here.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1517", "n1518", "n1519", "n1520", "n1523", "n1524", "n1525", "n1526", "n1528", "n1529", "n1532", "n1534", "n1535", "n1536", "n1537",
         "n1538", "n1539", "n1540", "n1542", "n1544", "n1545", "n1547", "n1548"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r20_probe.ts"
NINE = ["event", "projectId", "runId", "taskId", "title", "kind", "state", "attempt", "at"]


def scenario_sma_r20(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=600)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r20", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1517 sma status: both terminals, their claims, the open task's scope and the overlap of the claim with the task are shown; the other claim is not a collision.
    out = s["status"]["out"]
    ok = (s["status"]["exit"] == 0 and "thr_a" in out and "thr_b" in out and "claim ui: src/**" in out and "claim docs: docs/**" in out and "task t1 owns src/**" in out
          and re.search(r"collision: ui \(thr_a\) overlaps t1 \(task\)", out) is not None and "collision: docs" not in out)
    proofs.prove("n1517", ok, f"status lists thr_a and thr_b with their claims, task t1 owns src/**, collision line {'present' if 'collision: ui' in out else 'missing'}")
    # n1518 sma heartbeat: after 5.5 h the window that keeps sending is live with its claim, the quiet one is gone an hour later.
    proofs.prove("n1518", s["heartbeat"] == {"live": ["thr_a"], "claims": ["ui"]}, f"an hour later live windows {s['heartbeat']['live']}, claims {s['heartbeat']['claims']}")
    # n1519 sma claim: thr_a and thr_b hold different names; thr_b asking for thr_a's name is refused with the holder.
    c = s["claim"]
    ok = c["a"][0] == 0 and c["a"][1].startswith("claimed ui:") and c["b"] == [0] and c["taken"][0] == 1 and "thr_a" in c["taken"][1] and s["claims"] == ["docs:thr_b:docs/**", "ui:thr_a:src/**"]
    proofs.prove("n1519", ok, f"thr_b asking for ui: exit {c['taken'][0]} '{c['taken'][1]}'; claims now {s['claims']}")
    # n1520 sma release: a foreign release is refused and the claim stays; the holder's release ends it and says what edits are left.
    r = s["release"]
    ok = r["verb"][0] == 1 and "thr_a" in r["verb"][1] and r["a"][0] == 0 and r["a"][1].startswith("released ui (abandoned)\nedits_left:") and r["left"] == 0
    proofs.prove("n1520", ok, f"thr_b releasing thr_a's claim: exit {r['verb'][0]}; the holder's release: '{r['a'][1].splitlines()[0]}', claims left {r['left']}")
    # n1523 sma force-clear: no reason, or from a chat, clears nothing; with a reason the owner clears it, the record names the holder, and thr_b can take the name.
    f = s["forceClear"]
    ok = f["noReason"] == [1, 1] and f["fromChat"] == 1 and f["cleared"][0] == 0 and "thr_a" in f["cleared"][1] and f["takeover"] == 0 and f["now"] == ["ui:thr_b"] and f["holderRecord"] == "thr_a"
    proofs.prove("n1523", ok, f"without reason exit {f['noReason'][0]} (claims kept {f['noReason'][1]}), from a chat exit {f['fromChat']}; cleared '{f['cleared'][1]}'; then claims {f['now']}")
    # n1524 sma ask: the question goes to the asked terminal only, a repeat is not sent twice, a third terminal cannot answer, the asker gets the answer.
    a = s["ask"]
    ok = a["first"] == ["thr_writer", True, True] and a["repeat"] is True and a["sentBeforeAnswer"] == 1 and "only the asked" in a["intruder"] and a["answer"] == ["thr_pm", True] and a["answeredAt"] == 1000000
    proofs.prove("n1524", ok, f"question to {a['first'][0]}, repeat waiting={a['repeat']}, third terminal: '{a['intruder']}', answer went to {a['answer'][0]}")
    # n1525 sma tia: the changed file selects the test that imports it and not the unrelated one.
    proofs.prove("n1525", s["tia"] == {"alpha": True, "beta": False}, f"test:changed --list on a changed widget.ts: {s['tia']}")
    # n1526 sma state: the command adds its lines in its own block, the person's text stays and the block reads back.
    st = s["state"]
    ok = st["keepsHand"] and st["outsideSame"] and st["blockHasWal"] == ["manual: use WAL"] and st["parsed"] == ["manual: use WAL"] and st["stage"] == ["stage execution"]
    proofs.prove("n1526", ok, f"decisions in the block {st['parsed']}, position {st['stage']}, person's text unchanged {st['outsideSame']}")
    # n1528 sma flight / resume / handoff: the second writer's brief carries the first one's stop reason, dirty files, last failing command and the instruction.
    h = s["handoff"]
    proofs.prove("n1528", all(h.values()), f"brief carries {h}")
    # n1529 sma snapshot: an https webhook gets the nine fields only; an http address, and a project with none, post nothing.
    p = s["post"]
    ok = p["http"] is False and p["https"] is True and p["other"] is False and p["posts"] == 1 and p["keys"] == NINE and p["projectId"] == "P" and p["leak"] is False
    proofs.prove("n1529", ok, f"http -> {p['http']}, https -> {p['https']}, other project -> {p['other']}, {p['posts']} post with keys {p['keys']}, leak {p['leak']}")
    # n1532 sma sync-branch: main with another writer's work comes into a merged writer's copy; a dirty copy is refused; a clash is undone and names the file.
    y = s["sync"]
    ok = y["merged"] == ["merged", "merged"] and y["status"] == "synced" and y["head"] and y["sawOther"] and y["again"] == "up-to-date" and y["dirty"] == "dirty" and y["clash"] == ["conflict", True, True, True]
    proofs.prove("n1532", ok, f"sync {y['status']} (saw the other writer's file {y['sawOther']}), again {y['again']}, dirty copy {y['dirty']}, clash {y['clash']}")
    # n1534 Session lease registry: both terminals are live with their provider, none after the lease runs out.
    g = s["registry"]
    proofs.prove("n1534", g["live"] == ["thr_a", "thr_b"] and g["provider"] == "claude-code" and g["afterTtl"] == 0, f"live {g['live']}, provider {g['provider']}, live after 7 h {g['afterTtl']}")
    # n1535 Atomic claims: of two claims fired together exactly one wins the name; an invalid glob stores nothing.
    q = s["race"]
    proofs.prove("n1535", q["winners"] == 1 and q["loser"] == "claim_taken" and q["kept"] == 1 and q["invalid"] == "invalid_glob" and q["afterInvalid"] == ["api"], f"winners {q['winners']}, loser {q['loser']}, invalid glob {q['invalid']}, claims kept {q['afterInvalid']}")
    # n1536 Glob collision detector: claim against claim and claim against an open task are named, disjoint globs are not, malformed input gives [].
    k = s["collision"]
    ok = {"a": "ui", "b": "page", "kind": "claim"} in k["hits"] and {"a": "ui", "b": "t1", "kind": "task"} in k["hits"] and not any("docs" in (h2["a"], h2["b"]) for h2 in k["hits"]) and k["bad"] == []
    proofs.prove("n1536", ok, f"overlaps {k['hits']}, malformed input {k['bad']}")
    # n1537 Shared counters: the migration lock holds every statement at its index; an addition at the end is taken, one slotted into the middle is refused.
    m = s["slots"]
    proofs.prove("n1537", m["locked"] and m["appendOk"] and "does not match the recorded statement" in m["middle"], f"lock holds {m['locked']}, append at the end {m['appendOk']}, in the middle '{m['middle'][:70]}'")
    # n1538 Window journal: a foreign release is refused and leaves no record; the holder's release leaves one under its name.
    ok = r["forged"] == [False, "not_holder", "thr_a"] and r["evidenceAfterForgery"] == 0 and r["records"] == ["docs:thr_b", "ui:thr_a"]
    proofs.prove("n1538", ok, f"forged release {r['forged']}, records after it {r['evidenceAfterForgery']}, records after the holders' releases {r['records']}")
    # n1539 Live work fingerprint: the branch and at most 50 dirty paths.
    proofs.prove("n1539", s["fingerprint"] == {"branch": "feat", "n": 50}, f"fingerprint of 60 dirty paths {s['fingerprint']}")
    # n1540 Attempt trail of a person window: each release leaves its own record with the base, the files and the outcome told apart.
    ok = r["outcomeUi"] == [False, "abandoned"] and r["outcomeDocs"] == [True, "handed_off"] and r["filesUi"] == "src/app.ts" and r["baseUi"] == "ba5e123"
    proofs.prove("n1540", ok, f"ui: outcome {r['outcomeUi']}, files {r['filesUi']}, base {r['baseUi']}; docs: outcome {r['outcomeDocs']}")
    # n1542 Merge gate: a candidate that did not take main in is refused with «base moved» and main stays; after taking main in it merges.
    gt = s["gate"]
    proofs.prove("n1542", gt["stale"] == ["failed", True, True] and gt["fresh"] == "merged" and gt["landed"], f"stale candidate {gt['stale']}, after taking main in {gt['fresh']}")
    # n1544 Branch sync with the trunk: a dirty copy is refused, a clash is undone (copy as it was) and names the file.
    proofs.prove("n1544", y["dirty"] == "dirty" and y["clash"] == ["conflict", True, True, True], f"dirty copy {y['dirty']}, clash {y['clash']} (status, names page.vue, head unchanged, tree clean)")
    # n1545 Fenced STATE.md section: the command's block is rewritten, the person's text stays byte for byte, a block without its end is not guessed at.
    proofs.prove("n1545", st["keepsHand"] and st["outsideSame"] and st["personalHeading"] and st["broken"], f"person's text kept {st['outsideSame']}, own heading marked {st['personalHeading']}, broken block refused {st['broken']}")
    # n1547 Pre-compaction flight recorder: the last 5 asks cut to 300 characters, 30 files and 30 claims.
    cp = s["capsule"]
    proofs.prove("n1547", cp["asks"] == ["ask 4", "ask 5", "ask 6", "ask 7", "ask 8"] and set(cp["askLen"]) == {300} and cp["files"] == 30 and cp["claims"] == 30, f"asks {cp['asks']}, lengths {cp['askLen']}, files {cp['files']}, claims {cp['claims']}")
    # n1548 Window reporter outward: exactly the nine fields, the long title clipped to 200, nothing the caller adds.
    b = s["body"]
    proofs.prove("n1548", b["keys"] == NINE and b["title"] == 200 and b["attempt"] == 3 and b["extra"] == [], f"keys {b['keys']}, title length {b['title']}, extra keys {b['extra']}")
    return proofs.verdict("sma_r20", checked=len(NODES))
