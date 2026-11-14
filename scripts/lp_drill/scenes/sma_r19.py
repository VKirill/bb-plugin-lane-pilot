"""Region 19 · Install, update, remove: the region scene (docs/sma-evidence.md, «Trace choice»), batch a (n1464 … n1497).

Installs, updates and removals happen on machines and write no row to the hub database. So the node-level trace is this scene. It runs the REAL install and
removal code of the commit under drill (src/rooms/native-install/*, the session hook writer, the guard apply, the memory migrations) against TEMP home
folders and a scratch database, through sma_r19_probe.ts — never the real home, no model turn, no write to the hub, no network. For each node it compares what the
files and rows look like afterwards with the node card's result, including that the person's own settings, lines and files are still there byte for byte.
Run: scripts/lp-drill.sh --scenario sma_r19.

Batch b (n1498 … n1516) adds n1498 roles in --agents, n1500 the session settings copy, n1501 state in the plugin database, n1502 / n1505 rules in the prompt, n1504 the memory
scaffold, n1508 / n1509 the install door and the installer, n1515 an update keeps the owner's files, n1516 the check of the reapplied guard. Core-resident and not proved here:
n1499, n1506, n1507, n1510 - n1514.

Core-resident nodes (the main claim lives in bb-core: n1474 npx init, n1477 engine copy, n1483 thin skills, n1495 done report, n1496 engine folder) are proved here
only for Lane Pilot's own half: the per-machine install result it reads, the receipt it stores, the graphs it offers and starts.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1464", "n1465", "n1466", "n1467", "n1468", "n1469", "n1470", "n1471", "n1472", "n1473", "n1474", "n1476", "n1477", "n1478", "n1479", "n1480", "n1481",
         "n1482", "n1483", "n1486", "n1487", "n1488", "n1489", "n1490", "n1492", "n1493", "n1494", "n1495", "n1496", "n1497",
         "n1498", "n1500", "n1501", "n1502", "n1504", "n1505", "n1508", "n1509", "n1515", "n1516"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r19_probe.ts"
EXCLUDE = "# my own\nbuild/\n**/.agents/runs/\n**/.agents/reports/\n**/.bb/chats/\n**/notes/lock/\n**/.zcode/\n"


def scenario_sma_r19(tmp: Path) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r19", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1464 /sma-deleteme: one apply cuts the lane hooks out of settings and codex config; the person's theme, comment, hooks and codex tables stay; a second apply changes nothing.
    c = s["n1464"]
    proofs.prove("n1464", c["theme"] == "owner" and c["commentKept"] and c["pre"] == ["bash /usr/local/bin/guardian-code.sh"] and c["stop"] == [["node /opt/gitnexus/hook.js"]] and c["codexKept"] and c["again"] is False,
                 f"settings after one apply {c}")
    # n1465 Dry-run removal plan: lists the entries and the moves, changes no byte.
    p = s["n1465"]
    proofs.prove("n1465", p["apply"] is False and p["settings"] == ["python3 ~/.agents/hooks/guard_shell.py", "python3 ~/.agents/hooks/sma_hooks.py"] and p["hasMoves"] and p["untouched"], f"dry-run plan {p}")
    # n1466 One explicit yes: no flag, false, a truthy string and 1 all leave the home as it was; only apply:true moves.
    y = s["n1466"]
    proofs.prove("n1466", y["notYes"] == [True, True, True, True] and y["yes"] is True and y["moved"] is True, f"four non-yes calls untouched {y['notYes']}, apply true moved {y['moved']}")
    # n1467 sma deleteme: the verb prints a dry run, --apply (only) applies.
    v = s["n1467"]
    proofs.prove("n1467", v["dry"] is False and v["dryUntouched"] and v["applied"] is True and v["gone"] and v["asked"] == [False, True], f"verb: dry apply={v['dry']}, with --apply={v['applied']}, host asked {v['asked']}")
    # n1468 Eight installer targets reversed.
    t = s["n1468"]
    proofs.prove("n1468", t["moved"] == [".agents/bin/lane-ctl", ".agents/bin/lane-foo", ".agents/bin/lane-memory", ".agents/hooks", ".config/opencode/agents/lane-critic.md",
                                         ".config/opencode/agents/lane-reviewer.md", ".config/opencode/agents/lane-writer.md", ".local/share/claude-lane-stack-installed"]
                 and t["bin"] == ["mytool"] and t["agents"] == ["custom.md"], f"moved {t['moved']}, left in bin {t['bin']}, agents {t['agents']}")
    # n1469 Memory corpus untouched.
    proofs.prove("n1469", s["n1469"] == {"corpusSame": True, "files": 3}, f"memory, skills and state files byte for byte {s['n1469']}")
    # n1470 Cut the managed blocks: the person's lines come back exactly; torn markers refuse and write nothing.
    proofs.prove("n1470", s["n1470"] == {"restored": True, "refused": [True, True]}, f"block cut {s['n1470']}")
    # n1471 Strip SMA hooks: five lane commands in four spellings gone, foreign ones stay.
    h = s["n1471"]
    proofs.prove("n1471", h["removed"] == 5 and h["pre"] == ["bash /usr/local/bin/guardian-code.sh", "python3 /home/p/.agents/hooks-other/d.py"] and h["sessionStart"] is None and h["stop"] == "node /opt/gitnexus/hook.js" and h["theme"] == "owner",
                 f"strip result {h}")
    # n1472 Restore the own status line: exactly the record; no record, the key goes.
    proofs.prove("n1472", s["n1472"] == {"restored": {"type": "command", "command": "node /opt/my-line.js --fancy", "padding": 2}, "withoutRecord": None}, f"status line {s['n1472']}")
    # n1473 The workflow removes itself (our half: the plugin removal runs remove on every registered machine; the artifact itself is bb-core's).
    r = s["n1473"]
    proofs.prove("n1473", r["ownedGone"] and r["rootGone"] and r["foreign"] and r["ownedKeyGone"] and r["personal"] == "mine" and r["rowsAfterRemove"] == [] and r["stopped"] == "machine offline" and r["kept"] == ["native-install:host:h2"],
                 f"after plugin remove {r}")
    # n1474 npx sma-framework init (our half: the per-machine install writes the guard from the bundle, repeats to the same bytes, leaves the person's files).
    proofs.prove("n1474", s["n1474"] == {"installed": "enabled", "guardSame": True, "personSame": True, "repeatSame": True}, f"install into an empty home {s['n1474']}")
    # n1476 Never install into the clone.
    w = s["n1476"]
    proofs.prove("n1476", w["reasons"][0] == "Invalid managed install path" and w["reasons"][1] == "Invalid managed install path" and w["reasons"][2].startswith("Managed install parent is a symlink") and w["real"], f"refusals {w['reasons']}, real folder accepted {w['real']}")
    # n1477 Copy the sma-core engine (our half: the status reads what is on disk).
    proofs.prove("n1477", s["n1477"] == {"before": "absent", "after": "enabled", "guardGone": "absent"}, f"status {s['n1477']}")
    # n1478 Paths rewritten for the project.
    l = s["n1478"]
    proofs.prove("n1478", l["calls"] and l["copied"] == "print('project check')\n" and l["outside"] and l["origs"] == ["orig-0-check.py"] and l["projectSame"], f"project hook rewritten to the session copy: {l}")
    # n1479 Copy the scripts/sma runtime: every file a hook command names exists.
    proofs.prove("n1479", s["n1479"]["missing"] == [] and s["n1479"]["commands"] > 5 and s["n1479"]["guardLine"], f"hook commands {s['n1479']['commands']}, missing files {s['n1479']['missing']}")
    # n1480 Roles into .claude/agents (a definition per role, built for the session).
    proofs.prove("n1480", s["n1480"] == {"defs": [True, True], "distinct": True}, f"definitions {s['n1480']}")
    # n1481 Appended role lines are kept.
    k = s["n1481"]
    proofs.prove("n1481", k["lines"] == ["2026-11-01: never touch the lock file", "2026-11-03: keep the diff small"] and k["tail"].endswith("\n- 2026-11-01: never touch the lock file\n- 2026-11-03: keep the diff small") and k["unchanged"],
                 f"lines kept and appended to a new role text: {k['tail']!r}")
    # n1482 The list of commands: curated.
    o = s["n1482"]
    proofs.prove("n1482", o["code"] and not o["fragment"] and not o["pipeline"] and o["rule"] and 5 < o["offered"] < o["all"], f"offered {o['offered']} of {o['all']} graphs, fragment offered {o['fragment']}")
    # n1483 Thin /sma-* skills (our half: a published graph starts by id, no SKILL.md; a fragment is refused).
    proofs.prove("n1483", s["n1483"] == {"ran": "running", "refused": "refused", "started": ["companion"]}, f"run_workflow {s['n1483']}")
    # n1486 The SMA hook table.
    proofs.prove("n1486", s["n1486"]["events"] == ["PostToolUse", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "SubagentStop", "UserPromptSubmit"] and s["n1486"]["onceEach"], f"events {s['n1486']['events']}")
    # n1487 Commands anchored to the root: an absolute path, quoted, resolves from any working folder.
    a = s["n1487"]
    proofs.prove("n1487", a["command"].startswith("python3 '/") and a["resolves"], f"command {a['command']}")
    # n1488 Broken settings.json: four kinds of broken, four refusals, four files unchanged.
    proofs.prove("n1488", s["n1488"] == {"refused": [True, True, True, True]}, f"refusals {s['n1488']}")
    # n1489 Lossless hook merge.
    proofs.prove("n1489", s["n1489"] == {"matchers": ["Bash", "Edit", "*"], "comment": True, "repeatSame": True}, f"merge {s['n1489']}")
    # n1490 Stale entries removed: three spellings of our guard reduced to the first one.
    proofs.prove("n1490", s["n1490"] == {"copies": 1, "firstKept": True, "person": True}, f"stale copies {s['n1490']}")
    # n1492 .sma folders and gitignore line (our form: the bookkeeping lines in .git/info/exclude).
    e = s["n1492"]
    proofs.prove("n1492", e["added"] == 5 and e["text"] == EXCLUDE and e["second"] == [] and e["repeatSame"] and not e["gitignore"], f"info/exclude {e['text']!r}")
    # n1493 Memory skeleton, no notes: an old database is brought forward, the note is kept.
    m = s["n1493"]
    proofs.prove("n1493", m["oldHadStatus"] is False and m["kept"] == {"content": "the old note", "status": "active", "trust": "confirmed"} and m["ftsColumns"] == ["id", "project_id", "content", "concepts"] and m["found"] == [{"id": "old"}],
                 f"migrated old schema {m}")
    # n1494 Rules block in CLAUDE.md (our form: the PM prompt block).
    q = s["n1494"]
    proofs.prove("n1494", q == {"none": None, "pm": True, "writer": False, "claudeMdSame": True}, f"rules block {q}")
    # n1495 Done: run /sma-start (our half: the receipt of what the machine did is returned and stored).
    d = s["n1495"]
    proofs.prove("n1495", d["blocked"] == "blocked" and d["storedBlocked"] is None and d["ok"] == "ok" and d["native"] == "enabled" and d["saved"] == ["ok", "enabled"] and d["error"] == "machine refused the install" and d["afterFail"] == "ok",
                 f"install receipt {d}")
    # n1496 Engine .claude/sma-core (our half: the old installer's checkout is moved aside).
    proofs.prove("n1496", s["n1496"] == {"moved": True, "gone": True, "backup": "# old installer\n"}, f"old checkout {s['n1496']}")
    # n1497 Runtime scripts/sma in the project (our form: hook programs from the bundle in the session folder).
    proofs.prove("n1497", s["n1497"] == {"bundled": [True, True, True], "refreshed": True}, f"bundled hook files {s['n1497']}")

    # ---- batch b ----
    # n1498 Roles: one --agents definition per role with the compiled text; nothing written into .claude/agents.
    r = s["n1498"]
    proofs.prove("n1498", r["keys"] == ["dev-orchestrator"] and r["description"] and r["prompt"] and r["projectSame"] and r["agents"] == ["mine.md"], f"role definition {r}")
    # n1500 Settings: a copy in the session folder, the person's files untouched, their keys and hooks merged, the guard once.
    r = s["n1500"]
    proofs.prove("n1500", r["inSession"] and r["projectSame"] and r["model"] == "claude-local" and r["env"] == {"KEEP_ME": "1"} and r["person"] and r["guards"] == 1, f"session settings {r}")
    # n1501 Project state: rows in the plugin database, no state folder in the project.
    r = s["n1501"]
    proofs.prove("n1501", r["runs"] == [{"id": "lprun-b1", "project_id": "proj-b", "state": "pending"}] and r["secondHandle"] == 1 and r["fk"] == 1 and r["projectSame"] and r["noSmaFolder"], f"run state {r}")
    # n1502 Managed blocks in CLAUDE.md: a prompt block, no markers, the file untouched.
    r = s["n1502"]
    proofs.prove("n1502", r["empty"] == "" and r["lines"] == ["- Quote the contract wording when you ask the owner a question", "- Never plan past the signed context, whatever the owner's hurry says"] and not r["marker"] and r["claudeMdSame"], f"rules block {r}")
    # n1504 Memory corpus scaffold: the table with its rules, empty.
    r = s["n1504"]
    proofs.prove("n1504", r["empty"] == [0, 0] and r["inserts"] == ["ok", "ok", "refused", "refused"] and r["after"] == 2, f"scaffold {r}")
    # n1505 Rules block splice: into the prompt, whole lines, a torn CLAUDE.md left alone.
    r = s["n1505"]
    proofs.prove("n1505", r["lines"] == ["- Keep every diff under two hundred lines", "- Ask before touching the lock file"] and not r["torn"] and r["claudeMdSame"], f"resume instructions {r}")
    # n1508 One explicit yes: no yes, nothing runs and nothing is stored.
    r = s["n1508"]
    proofs.prove("n1508", r["blocked"] == "blocked" and r["callsBlocked"] == 0 and r["stored"] is None and r["ok"] == "ok" and r["reason"].endswith("no operation was run."), f"install door {r}")
    # n1509 Re-run the standard installer: the project's machine only, repeatable.
    r = s["n1509"]
    proofs.prove("n1509", r["calls"] == [{"method": "nativeInstall", "action": "install", "requested": "host-up"}] and r["hosts"] == ["native-install:host:host-up"] and r["first"] == "enabled" and r["second"] == "enabled" and r["guardIsBundle"] and r["repeatSame"], f"installer {r}")
    # n1515 What an update preserves: the owner's memory, skills, state, settings; an edited guard stays.
    r = s["n1515"]
    proofs.prove("n1515", r["placed"] and r["status"] == "enabled" and r["personSame"] and r["guardKept"], f"update over owner files {r}")
    # n1516 Check of reapplied patches: applied only for the bundled file and exactly one hook entry; owner lines survive.
    r = s["n1516"]
    proofs.prove("n1516", r["steps"] == [False, True, False, True, False] and r["repaired"] == 1 and r["ownerKept"], f"guard check {r}")
    return proofs.verdict("sma_r19", checked=len(NODES))
