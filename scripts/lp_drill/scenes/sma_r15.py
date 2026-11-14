"""Region 15 · How we prove it: the region scene of the SMA map (docs/sma-evidence.md, «Trace choice»).

The region is about the proving machinery itself, so this scene runs the real drill code of the commit under drill and prove()s what it
observed, model-free: the preparation, the scout, the series loop and its manifest, the judges, the metrics suite, the evidence reader, the two
story files (as vitest scenes, the way a series runs them), the coverage verdict, and the record code (book chain, dossier, realtime stream)
on a scratch in-memory database (sma_r15_probe.ts). Only the parts that need a machine the drill host has and a developer machine lacks are
replaced or skipped, and the detail of each proof says which: the series' scene processes (replaced by receipts, for the order and the hung-scene
cases), the series preparation of a series loop (replaced, it is proved on its own), the hub's attempt metrics (stubbed). A node whose check needs
the hub (n1130, n1142) is proved only where the hub answers; the scene lists the nodes it could not prove under `notProved`.
Run: scripts/lp-drill.sh --scenario sma_r15.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1120", "n1123", "n1127", "n1129", "n1130", "n1131", "n1132", "n1133", "n1134", "n1135", "n1136", "n1137", "n1138", "n1139", "n1140", "n1141", "n1142", "n1143"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r15_probe.ts"
DOOR = ROOT / "scripts/lp-drill.py"
SUITE_ORDER = ["task", "batch", "phase", "release", "window", "worker", "lockstep", "wiring", "metrics"]
PREP_PARTS = ["database", "receipts", "browser", "accounts", "limits", "window", "person"]


def _door():
    """The real lp-drill.py of this checkout as a module of its own (its functions are the ones a series runs)."""
    spec = importlib.util.spec_from_file_location("lp_drill_door_r15", DOOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.log = lambda *a, **k: None
    return module


def _series(door, argv: list[str], tmp: Path, fake_run=None, problems=None) -> dict:
    """main() of the drill for a series, the preparation replaced; `fake_run(args)` replaces the processes it starts (None: the real ones)."""
    calls: list[list[str]] = []
    real_run, real_prep, real_metrics = door.run, door.series_preparation, door.series_metrics
    head, scout = door.git(str(ROOT), "rev-parse", "HEAD"), door.scout()
    door.series_preparation = lambda names=None: {"commit": head, "version": "r15", "scout": scout, "sandboxClean": True, "checks": [], "problems": problems or [], "coverageGaps": []}
    door.series_metrics = lambda scenes, d: {"suite": "metrics", "verdict": "pass", "problems": [], "scenes": len(scenes), "receipts": 0}
    if fake_run is not None:

        def run(args, stdin=None, timeout=180, env=None):
            calls.append(list(args))
            rc, out = fake_run(list(args), real_run)
            return rc, out, ""
        door.run = run
    before = os.environ.get("LP_DRILL_RECEIPT_DIR")
    os.environ["LP_DRILL_RECEIPT_DIR"] = str(tmp)
    saved_argv = sys.argv
    sys.argv = ["lp-drill.py", *argv]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = door.main()
    finally:
        sys.argv = saved_argv
        door.run, door.series_preparation, door.series_metrics = real_run, real_prep, real_metrics
        if before is None:
            os.environ.pop("LP_DRILL_RECEIPT_DIR", None)
        else:
            os.environ["LP_DRILL_RECEIPT_DIR"] = before
    manifests = sorted(tmp.glob("series-*.json"), key=lambda p: p.stat().st_mtime)
    return {"rc": rc, "calls": calls, "manifest": json.loads(manifests[-1].read_text()) if manifests else None}


def _receipt_run(tmp: Path):
    def run(args, real_run):
        if args[1:2] == ["-I"]:
            name = args[4]
            path = tmp / f"scene-{name}.json"
            path.write_text(json.dumps({"seen": {"stages": {}}, "judged": [{"name": name, "verdict": "pass"}], "scenarios": [{"name": name, "result": "pass"}]}))
            return 0, f"RECEIPT={path}\n"
        return 0, ""
    return run


def scenario_sma_r15(tmp: Path) -> dict:
    proofs = Proofs()
    not_proved: dict[str, str] = {}
    probe = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=240)
    try:
        seen = json.loads(probe.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r15", [f"the probe printed no result (exit {probe.returncode}): {(probe.stderr or probe.stdout).strip()[-300:]}"])
    door = _door()

    # n1120 Attempt run folder: one attempt's dossier carries the stored stream, the hashed verifier commands and the verdict.
    d = seen["dossier"]
    proofs.prove("n1120", d["stream"] == "wrote hello.txt" and d["commands"] == ["npm test"] and d["sha"] and d["verdict"] == {"gate": "validate", "status": "passed"},
                 f"dossier stream {d['stream']!r}, verifier commands {d['commands']}, commands hash ok {d['sha']}, verdict {d['verdict']}")
    # n1123 Chain of book parts: appended parts link from the genesis, a rewritten part is named.
    c = seen["chain"]
    proofs.prove("n1123", c["links"] == [True, True, True] and c["first"] and c["intact"] is None and c["rewritten"] == 2, f"links {c['links']}, intact verdict {c['intact']}, rewritten part named {c['rewritten']}")
    # n1127 Event stream: a burst of one change is one signal, and an attempt move of a PM chat's run signals its helpers.
    sig = seen["signals"]
    proofs.prove("n1127", sig == [{"channel": "lp:proj_rt", "payload": {"kind": "workflow", "threadId": "thr_a", "runId": "wfrun_1"}}, {"channel": "lp:proj_rt", "payload": {"kind": "helpers", "threadId": "thr_pm"}}],
                 f"signals on the stream {json.dumps(sig)[:200]}")

    # n1131 Eleven suites: the scout of this commit names nothing ungrouped, regrouped, unknown or missing; the suites are the card's nine.
    scout = door.scout()
    clean = [scout[key] for key in ("ungrouped", "regrouped", "unknown", "unlisted", "undefined", "missingStories", "empty")]
    proofs.prove("n1131", list(scout["suites"]) == SUITE_ORDER and clean == [[]] * 7, f"suites {list(scout['suites'])}; ungrouped/regrouped/unknown/unlisted/undefined/missingStories/empty {clean}")
    # n1132 Three tasks, two batches, a phase: the task suite holds the three-task scene, the phase suite the phase scene, in the order task, batch, phase.
    suites = list(door.SUITES)
    three = door.tasks_parallel3(door.SANDBOX["cwd"])
    proofs.prove("n1132", suites[:3] == ["task", "batch", "phase"] and "parallel3" in door.SUITES["task"] and "phase" in door.SUITES["phase"] and bool(door.SUITES["batch"]) and callable(getattr(door, "scenario_phase", None)) and len(three) == 3,
                 f"suite order {suites[:3]}, task {door.SUITES['task'][:2]}, batch {door.SUITES['batch']}, phase {door.SUITES['phase'][:2]}, parallel3 writes {len(three)} tasks")

    # n1129 Graph release series + n1134 One process per scene: the real series loop, each scene process replaced by a receipt, one of them by a real timeout.
    green = _series(door, ["--series"], tmp, _receipt_run(tmp))
    order = [row["suite"] for row in green["manifest"]["scenes"]] if green["manifest"] else []
    ordered = [s for s in SUITE_ORDER if s in order] == list(dict.fromkeys(order)) and order == sorted(order, key=SUITE_ORDER.index)
    proofs.prove("n1129", bool(green["manifest"]) and ordered and green["manifest"]["verdict"] == "pass" and len(set(order)) == 8 and green["manifest"]["preparation"]["commit"] == door.git(str(ROOT), "rev-parse", "HEAD"),
                 f"{len(order)} scenes in suites {list(dict.fromkeys(order))}, verdict {green['manifest'] and green['manifest']['verdict']}, head {(green['manifest'] or {}).get('preparation', {}).get('commit', '')[:8]}")

    def hang_first(args, real_run):
        if args[1:2] == ["-I"] and args[4] == "parallel3":
            rc, out, _ = real_run(["sleep", "30"], timeout=1)
            return rc, out
        return _receipt_run(tmp)(args, real_run)
    t0 = time.time()
    hung = _series(door, ["--series"], tmp, hang_first)
    scene_calls = [call for call in hung["calls"] if call[1:2] == ["-I"]]
    rows = hung["manifest"]["scenes"] if hung["manifest"] else []
    stuck = next((row for row in rows if row["name"] == "parallel3"), {})
    ok = (len(scene_calls) > 20 and all(call[2] == str(DOOR) and call[3] == "--scenario" for call in scene_calls) and len({call[4] for call in scene_calls}) == len(scene_calls)
          and stuck.get("exit") == 124 and sum(1 for row in rows if row["exit"] == 0) == len(rows) - 1 and hung["manifest"]["verdict"] == "fail")
    proofs.prove("n1134", ok, f"{len(scene_calls)} scene processes, each `-I lp-drill.py --scenario <name>`; parallel3 timed out with exit {stuck.get('exit')} in {time.time() - t0:.1f}s and the other {len(rows) - 1} scenes still ran; verdict {hung['manifest'] and hung['manifest']['verdict']}")

    # n1135 Scout of named suites: a named run lists only what it names, prepares no series and leaves no manifest.
    scratch = tmp / "named"
    scratch.mkdir()
    env = {**os.environ, "LP_DRILL_RECEIPT_DIR": str(scratch)}
    named = subprocess.run([sys.executable, "-I", str(DOOR), "--scenario", "guard_hash,phase", "--dry-run"], capture_output=True, text=True, timeout=120, env=env)
    line = next((row for row in named.stdout.splitlines() if row.startswith("drill ") and "scenarios:" in row), "")
    listed = line.split("scenarios: ", 1)[1] if "scenarios: " in line else None
    listing = subprocess.run([sys.executable, "-I", str(DOOR), "--scout"], capture_output=True, text=True, timeout=120, env=env)
    scouted = json.loads(listing.stdout) if listing.returncode == 0 and listing.stdout.strip().startswith("{") else {}
    proofs.prove("n1135", named.returncode == 0 and listed == "guard_hash, phase" and not list(scratch.glob("*.json")) and list(scouted.get("suites", {})) == SUITE_ORDER,
                 f"--scenario guard_hash,phase lists «{listed}», exit {named.returncode}, files left {len(list(scratch.glob('*.json')))}; --scout prints the suites {list(scouted.get('suites', {}))}")

    # n1133 Window and worker stories + n1141 Series manifest: two real one-unit series, the unit being the story file itself.
    (tmp / "window").mkdir()
    (tmp / "worker").mkdir()
    window = _series(door, ["--suite", "window"], tmp / "window")
    worker = _series(door, ["--suite", "worker"], tmp / "worker")
    wm, km = window["manifest"], worker["manifest"]
    stories = [(wm or {}).get("scenes", [{}])[0], (km or {}).get("scenes", [{}])[0]]
    proofs.prove("n1133", [row.get("exit") for row in stories] == [0, 0] and [row.get("name") for row in stories] == ["vitest:tests/release-stories-window.test.tsx", "vitest:tests/release-stories-worker.test.ts"],
                 f"story scenes {[(row.get('name'), row.get('exit')) for row in stories]}")
    selected = {name: len(rows) for name, rows in (wm or {}).get("suites", {}).items() if rows}
    proofs.prove("n1141", bool(wm) and wm["kind"] == "lane-pilot-release-series" and wm["preparation"]["commit"] == door.git(str(ROOT), "rev-parse", "HEAD") and bool(wm["stamp"]) and selected == {"window": 1} and [r["name"] for r in wm["scenes"]] == ["vitest:tests/release-stories-window.test.tsx"],
                 f"manifest kind {wm and wm['kind']}, head {((wm or {}).get('preparation') or {}).get('commit', '')[:8]}, stamp {wm and wm['stamp']}, selected units {selected}")

    # n1130 Series preparation: the real preparation names its seven parts and refuses with a named part (or passes) on this machine.
    try:
        prep = door.series_preparation()
        names = [row["name"] for row in prep["checks"]]
        named_problems = all(any(problem.startswith(f"{part}:") for part in PREP_PARTS) for problem in prep["problems"])
        proofs.prove("n1130", names == PREP_PARTS and named_problems and isinstance(prep["coverageGaps"], list), f"checks {names}, {len(prep['problems'])} problem(s) {[p[:60] for p in prep['problems']]}, coverage gaps {len(prep['coverageGaps'])}")
    except Exception as cause:
        not_proved["n1130"] = f"the preparation needs the hub and its bb command: {str(cause)[:160]}"

    # n1136–n1138 the registry of this commit: live scenarios of the three graph suites, reasons of the uncovered, the strict verdict.
    cov = seen["coverage"]
    proofs.prove("n1136", cov["liveTask"] > 0 and cov["livePhase"] > 0 and cov["liveBatch"] > 0 and cov["live"] > 0, f"live claims: task {cov['liveTask']} (parallel3), batch {cov['liveBatch']}, phase {cov['livePhase']}; {cov['live']} of {cov['rows']} rows live")
    proofs.prove("n1137", cov["none"] > 0 and cov["noneWithoutReason"] == 0, f"{cov['none']} uncovered rows, {cov['noneWithoutReason']} without a reason")
    gaps = cov["gaps"] or []
    untermed = cov["untermed"] or []
    proofs.prove("n1138", cov["gaps"] is not None and sorted(gap.split(": ", 1)[0] for gap in gaps if "no term or owner word" in gap) == sorted(untermed) and (cov["strictExit"] == 0) == (not gaps),
                 f"strict verdict exit {cov['strictExit']}: {len(untermed)} uncovered row(s) without a term or the owner's word, each a gap; first {untermed[:2]}")

    # n1139 Suite report judge + n1140 Series judge: re-judge the newest real receipt's scenes with the real judges; with none, a synthetic set.
    receipts = sorted((ROOT / ".agents/runs/drills").glob("2*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    real = None
    for path in receipts:
        try:
            data = json.loads(path.read_text())
        except ValueError:
            continue
        if data.get("scenarios") and not any(str(name).startswith("sma_") for name in data.get("scenarioNames") or []) and data.get("result") == "pass":
            real = (path.name, data)
            break
    scenes = real[1]["scenarios"] if real else [{"name": "a", "result": "pass", "problems": [], "tasks": 3}, {"name": "b", "result": "pass", "problems": []}, {"name": "c", "result": "skipped", "problems": []}]
    judged = [door.judge_scenario(scene) for scene in scenes]
    expected = [("pass" if scene["result"] == "pass" and any(key not in ("name", "result", "problems") and scene[key] not in (None, [], {}, "") for key in scene) or (scene["result"] == "pass" and scene.get("note")) else "skipped" if scene["result"] == "skipped" else "fail") for scene in scenes]
    proofs.prove("n1139", [row["verdict"] for row in judged] == expected and all(row["why"] for row in judged if row["verdict"] == "fail"),
                 f"{len(judged)} scene(s) of {real[0] if real else 'a synthetic set'} judged: {[row['verdict'] for row in judged][:12]}")
    names = [scene["name"] for scene in scenes]
    series_all = door.judge_series(judged, names)
    series_missing = door.judge_series(judged[:-1], names) if len(judged) > 1 else {"verdict": "fail", "missing": names[-1:], "failed": [], "skipped": []}
    proofs.prove("n1140", series_all["missing"] == [] and series_all["verdict"] == ("fail" if any(row["verdict"] == "fail" for row in judged) else "pass") and series_missing["verdict"] == "fail" and series_missing["missing"] == names[-1:],
                 f"series verdict {series_all['verdict']} (failed {series_all['failed']}, skipped {len(series_all['skipped'])}); with {names[-1]!r} left out: {series_missing['verdict']}, missing {series_missing['missing']}")

    # n1143 Graph metrics: the metrics suite judges an archive last: a clean one passes, a scene that exited non-zero fails it. The hub's attempt metrics are stubbed.
    door.setting_rpc = lambda method, payload: {}
    def archive(rows):
        scenes_ = []
        for i, (code, results) in enumerate(rows):
            path = tmp / f"metrics-{i}.json"
            path.write_text(json.dumps({"seen": {"stages": {}}, "judged": [], "scenarios": [{"result": r} for r in results]}))
            scenes_.append({"name": f"s{i}", "suite": "task", "exit": code, "receipt": str(path)})
        return door.series_metrics(scenes_, tmp)
    clean_m, red_m, floor_m = archive([(0, ["pass", "pass"])]), archive([(3, ["pass"])]), archive([(0, ["pass", "fail", "fail"])])
    proofs.prove("n1143", clean_m["verdict"] == "pass" and red_m["problems"] == ["scene s0 exited 3"] and floor_m["verdict"] == "fail" and "floor" in " ".join(floor_m["problems"]),
                 f"clean archive {clean_m['verdict']}; exit 3 -> {red_m['problems']}; one green of three -> {floor_m['problems'][:1]}")

    # n1142 Run evidence: what the newest sandbox run left on the hub, read back nested (only where the hub answers).
    try:
        row = door.hubsql("select run_id as id from lane_pilot_stage_receipt order by updated_at desc limit 1;")
        evidence = door.evidence_seen(row[0]["id"]) if row else None
        if evidence is None:
            raise RuntimeError("the hub gave no run")
        proofs.prove("n1142", set(evidence) == {"stages", "gates", "moves"} and bool(evidence["stages"]) and all(isinstance(v, dict) and all(isinstance(states, dict) for states in v.values()) for v in evidence.values()),
                     f"run {row[0]['id']}: {len(evidence['stages'])} stages, {len(evidence['gates'])} gates, {len(evidence['moves'])} moves")
    except Exception as cause:
        not_proved["n1142"] = f"needs the hub: {str(cause)[:160]}"
    return proofs.verdict("sma_r15", checked=len(NODES) - len(not_proved), notProved=not_proved)
