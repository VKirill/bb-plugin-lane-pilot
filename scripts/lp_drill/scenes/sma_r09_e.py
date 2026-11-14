"""Region 9 · Person and window, batch e (n882 … n916) — proofs of the region scene sma_r09 (docs/sma-evidence.md, «Trace choice»).

Every node of this batch is a screen of the window (or the server half of one). The tests of the checked-out commit (tests/sma/four-proofs-r09-e.test.ts,
.test.tsx and -e2.test.tsx) render each screen for real in jsdom, press what the person presses and write down what the window SENT or DREW (or what the server
produced) as one JSON line per node (tests/sma/r09-world-e.ts, observe()). This scene runs those tests once, reads the lines and compares every value with what
the card says, so a node is proved by the value, not by «the tests pass». No model, no hub write.
Run: scripts/lp-drill.sh --scenario sma_r09 (this module adds its nodes to that scene).
"""
from __future__ import annotations

import json
import os
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

TEST_FILES_E = ["tests/sma/four-proofs-r09-e.test.ts", "tests/sma/four-proofs-r09-e.test.tsx", "tests/sma/four-proofs-r09-e2.test.tsx"]
NODES_E = ["n882", "n883", "n884", "n885", "n886", "n887", "n888", "n889", "n890", "n891", "n892", "n893", "n894", "n895", "n899",
           "n900", "n901", "n904", "n905", "n906", "n907", "n908", "n909", "n910", "n911", "n912", "n913", "n914", "n915", "n916"]


def _checks(v: dict) -> dict[str, tuple[bool, str]]:
    """node -> (the observed value is the card's, what was observed). `v` is node -> the value its test wrote down."""
    def get(node: str) -> dict:
        return v.get(node) or {}

    out: dict[str, tuple[bool, str]] = {}
    a = get("n882")
    out["n882"] = (a.get("whenAnswering") is False and a.get("whenSilent") == "The hub does not answer — the screens show what they saw last." and a.get("screenKept") is True,
                   f"pulse answering -> silent line shown {a.get('whenAnswering')}; pulse failing -> {a.get('whenSilent')!r}; screen kept {a.get('screenKept')}")
    a = get("n883")
    out["n883"] = (a.get("sent") == [{"screen": "phases", "text": "the button is dead"}] and "Title: Lane Pilot: fault on «phases»" in a.get("shown", "") and "the button is dead" in a.get("shown", "") and "Nothing was sent" in a.get("shown", ""),
                   f"fault sent {a.get('sent')}; shown {a.get('shown')!r}")
    a = get("n884")
    out["n884"] = (a.get("text") == "Need a new worker?Open the forge" and a.get("navigated") == [{"method": "toPluginPanel", "path": "lane-pilot-cockpit", "options": {"subPath": "forge"}}],
                   f"block says {a.get('text')!r}; the button navigated {a.get('navigated')}")
    a = get("n885")
    out["n885"] = (a.get("before") == {"provider": "claude-code", "model": "claude-opus-5-5", "effort": "high"}
                   and a.get("saved") == {"projectId": "proj_ui", "key": "role_model.analyst", "expectedVersion": 3, "value": {"provider": "acp-cursor", "model": "grok-4.6", "reasoning_effort": "medium", "pool": [{"provider": "codex", "model": "gpt-6.1-sol"}]}},
                   f"picker showed {a.get('before')}; the choice saved {a.get('saved')}")
    a = get("n886")
    out["n886"] = (a.get("sent") == [{"projectId": "p1", "kind": "role", "name": "yard-keeper", "brief": "x" * 20}] and a.get("skillHasBody") is True and a.get("roleHasBody") is False,
                   f"order sent {a.get('sent')}; body box for a skill {a.get('skillHasBody')}, for a role {a.get('roleHasBody')}")
    a = get("n887")
    out["n887"] = (a.get("lines") == ["Дизайнер ещё учится: 2 of 8 drawings.", "✗ 2 of 8 drawings", "✓ critique pass 1 (≥ 0.8)", "drawings: 2 · firstPass: 0 · judgeAgrees: — · ownerYes: 0.5"], f"designer panel {a.get('lines')}")
    a = get("n888")
    out["n888"] = (a.get("a", {}).get("drawings") == 2 and a.get("a", {}).get("firstPass") == 0.5 and a.get("a", {}).get("conditions") == ["2 of 8 drawings", "first pass 0.5 (≥ 0.7)", "critique pass 1 (≥ 0.8)", "no «no» among the last five"]
                   and a.get("a", {}).get("readiness", "").startswith("Дизайнер ещё учится: 2 of 8 drawings; first pass 0.5") and a.get("b", {}).get("drawings") == 1
                   and a.get("b", {}).get("last") == {"id": "no_recent_no", "ok": False, "detail": "the owner said no among the last five"} and a.get("all") == 3,
                   f"project a {a.get('a')}; project b {a.get('b')}; no project {a.get('all')} drawings")
    a = get("n889")
    out["n889"] = (a.get("lines") == ["pick навыки проекта «p1»Use when picking.", "gen общие BB"] and "общие навыки BB, навыки проекта «p1»" in a.get("empty", "") and "общие навыки BB, навыки проекта" in a.get("defaults", ""),
                   f"skills {a.get('lines')}; empty list says {a.get('empty')!r}")
    a = get("n890")
    out["n890"] = (a.get("onlyThese") == {"role": "writer", "version": 2, "value": {"skills": {"mode": "allow", "names": ["lp-writer"]}}} and a.get("added") == {"skills": {"mode": "allow", "names": ["lp-writer", "ru-text"]}},
                   f"«only these» saved {a.get('onlyThese')}; a skill added saved {a.get('added')}")
    a = get("n891")
    out["n891"] = (a.get("tail", "").endswith("<owner_text>\n## My own skill text\n\ndo exactly this\n</owner_text>") and "word for word" in a.get("tail", "") and a.get("blankSame") is True and a.get("file") == "You are the Creator (forge). Write exactly one skill draft, .agents/forge/skills/mine/SKILL.md, and nothing else.",
                   f"brief tail {a.get('tail')!r}; blank text leaves the brief unchanged {a.get('blankSame')}")
    a = get("n892")
    out["n892"] = (a.get("text") == "Run the lint before every commit." and a.get("sevenLettersOff") is True and a.get("eightLettersOn") is True and a.get("decidedListed") is False and a.get("waitingBlockWithNone") is False,
                   f"draft text {a.get('text')!r}; accept off at 7 letters {a.get('sevenLettersOff')}, on at 8 {a.get('eightLettersOn')}; decided listed {a.get('decidedListed')}")
    a = get("n893")
    out["n893"] = (a == {"orphan": True, "vouched": False, "marks": 1}, f"records marked «no trace» {a}")
    a = get("n894")
    out["n894"] = (a.get("checked") == {"active": 2, "added": 1, "stale": 0} and a.get("said") == "Перестроено записей: 2 (добавлено 1, убрано 0)" and a.get("foundAfter") is True and a.get("again") == "Перестроено записей: 2",
                   f"check run {a.get('checked')}; button says {a.get('said')!r}; found again {a.get('foundAfter')}; second run {a.get('again')!r}")
    a = get("n895")
    out["n895"] = (a.get("sent") == [{"runId": "run_1", "action": "tags"}] and a.get("sizes") == [["billing", "12px"], ["ledger", "15px"], ["rare", "18px"]], f"tag sizes {a.get('sizes')}")
    a = get("n899")
    out["n899"] = ("Claude Code and Codex: everything." in a.get("whole", "") and "Grok (Cursor) and OpenCode: everything except CLI plugins; Cursor's own skills cannot be turned off; project instructions cannot be turned off." in a.get("whole", ""),
                   f"access panel says {a.get('whole')!r}")
    a = get("n900")
    out["n900"] = (a.get("lines") == {"h1": "Mac mini: на связи · окна: five_hour 42% · проекты: pa, pb · сегодня: принято 1, стоит 1, идёт 0", "h2": "Big: на связи · окна: five_hour 42% · проекты: — · сегодня: принято 0, стоит 0, идёт 0"},
                   f"household lines {a.get('lines')} (a three-day-old accepted work of a third project is not counted)")
    a = get("n901")
    out["n901"] = (a.get("h1") == "Mac mini: на связи" and a.get("h2") == "Big: не отвечает (last seen 10 min ago)" and a.get("letGo") == ["h1"] and a.get("emptyList") == ["h1"],
                   f"rows {a.get('h1')!r} / {a.get('h2')!r}; after a machine left BB's list {a.get('letGo')}; after an empty list {a.get('emptyList')}")
    a = get("n904")
    out["n904"] = (a.get("unused") == ["get_role_models"] and a.get("none") == ["get_screen", "list_projects", "phase_get", "get_role_models", "cockpit_workers", "money_status"] and a.get("realCount") is True,
                   f"reads no screen calls {a.get('unused')}; with nothing used {a.get('none')}")
    a = get("n905")
    out["n905"] = ("https://hub.example · WireGuard (no public bb connect)" in a.get("door", "") and a.get("joinAndLetGo") == [True, True] and a.get("called") == ["actions_recent", "cockpit_seen_list", "door_audience", "peers_list"],
                   f"door panel {a.get('door')!r}; calls {a.get('called')}")
    a = get("n906")
    out["n906"] = (a.get("tiles") == a.get("expected") and "System" in a.get("tiles", []) and a.get("tiles", [""])[0] == "Phases" and len(a.get("tiles", [])) == 13
                   and a.get("opened") == {"method": "toPluginPanel", "path": "lane-pilot-cockpit", "options": {"subPath": "money"}}, f"home tiles {a.get('tiles')}; a tile opened {a.get('opened')}")
    a = get("n907")
    out["n907"] = (a.get("withoutRun") is False and a.get("steps") == ["1 · Found", "2 · Take as drafts", "3 · Drafts"], f"panel without a run {a.get('withoutRun')}; steps with a run {a.get('steps')}")
    a = get("n908")
    out["n908"] = (a.get("rows") == ["yard claudeA yard agent.", "ranger codex.codex/agents/ranger.toml"] and a.get("asked") == [{"runId": "run_1"}] and a.get("emptySays") == "Nothing yet.", f"found helpers {a.get('rows')}")
    a = get("n909")
    out["n909"] = (a.get("offAtStart") is True and a.get("sent") == [{"runId": "run_1", "names": ["yard", "ranger"]}], f"take button off at start {a.get('offAtStart')}; sent {a.get('sent')}")
    a = get("n910")
    out["n910"] = (a.get("before") == ["yard: appliedCheck and enable", "ranger: kept: a draft with this name existsCheck and enable", "scout: conflict"]
                   and a.get("after") == ["yard: awaits your «да»", "ranger: kept: a draft with this name existsCheck and enable", "scout: conflict"], f"drafts before {a.get('before')}; after enabling the first {a.get('after')}")
    a = get("n911")
    out["n911"] = (a == {"empty": "firstrun", "slash": "firstrun", "real": "money", "done": "home", "realDone": "money"}, f"start screen {a}")
    a = get("n912")
    out["n912"] = (a.get("asked") == "2/4 · Which writer?" and a.get("next") == "3/4 · How strict?" and a.get("onWithWords") is True, f"asked {a.get('asked')!r} then {a.get('next')!r}")
    a = get("n913")
    out["n913"] = (a.get("ready") == "Ready✓ goal: a shop✓ writer: codex / gpt-6-luna" and a.get("empty") == "Ready", f"ready column {a.get('ready')!r}; before any answer {a.get('empty')!r}")
    a = get("n914")
    out["n914"] = (a.get("a") == ["Risk: high", "Base: 01234567 · lp/t1", "Cost: $0.500"] and a.get("b") == ["", "Base: not recorded (folder without git)", "Cost: $12.50"] and a.get("c", ["", "", ""])[2] == "Cost: $3.00, 1 of 2 attempts measured"
                   and a.get("fallback") == "Save the form○the form saves", f"frame chips {a.get('a')} / {a.get('b')} / {a.get('c')}; fallback {a.get('fallback')!r}")
    a = get("n915")
    out["n915"] = (a.get("head") == "Make the cart its own phaseShop" and a.get("why") == "Why this is for you: The lead proposes a direction." and a.get("buttons") == ["Yes", "No"] and a.get("todo") == "What to do: bb lane-pilot migrate · bb lane-pilot verify",
                   f"card {a.get('head')!r}, {a.get('why')!r}, buttons {a.get('buttons')}, commands {a.get('todo')!r}")
    a = get("n916")
    out["n916"] = (a.get("reads") == [{"runId": "run", "relativePath": "src/a.ts", "offset": 0}, {"runId": "run", "relativePath": "npm test", "offset": 0}] and a.get("starHasButton") is False and a.get("shown") == "export const a = 1; …",
                   f"file reads {a.get('reads')}; a pattern has a button {a.get('starHasButton')}; text shown {a.get('shown')!r}")
    return out


def prove_e(proofs: Proofs, tmp) -> None:
    obs = os.path.join(str(tmp), "r09-e-observations.jsonl")
    open(obs, "w").close()
    run = subprocess.run(["npx", "--yes", "vitest", "run", *TEST_FILES_E, "--maxWorkers=2", "--reporter=json"], cwd=ROOT, capture_output=True, text=True, timeout=1500, env={**os.environ, "SMA_R09E_OBS": obs})
    try:
        report = json.loads(run.stdout[run.stdout.index("{"):])
        cases = [case for file in report["testResults"] for case in file["assertionResults"]]
        error = ""
    except (ValueError, KeyError):
        cases, error = [], f"no vitest report (exit {run.returncode}): {(run.stderr or run.stdout).strip()[-200:]}"
    values: dict[str, dict] = {}
    for line in open(obs, encoding="utf-8").read().splitlines():
        if line.strip():
            row = json.loads(line)
            values[row["node"]] = row["value"]
    failed = [case["title"][:60] for case in cases if case["status"] != "passed"]
    checks = _checks(values)
    for node in NODES_E:
        if node not in values:
            proofs.prove(node, False, error or f"the tests wrote no observation for {node}")
            continue
        ok, detail = checks[node]
        proofs.prove(node, ok and not failed, detail + (f"; tests failed: {failed}" if failed else ""))
