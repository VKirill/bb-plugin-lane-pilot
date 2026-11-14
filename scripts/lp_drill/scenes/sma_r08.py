"""Region 8 · Daemon front outside the graphs: the region scene (docs/sma-evidence.md, «Trace choice»).

The front's doors, roster and helper import write no hub table row (the journal and the conveyor live in plugin KV, the helper drafts go to a
machine), so each node is proved here. The probe (sma_r08_probe.ts, run by vite-node) boots the plugin on a fake host and calls the REAL door,
the REAL roster reads and the REAL helper import of the commit under drill, on a scratch database with a fake machine client (no model, no hub
write, nothing outside the machine). The scene compares each value with the node's card and prove()s it with what was seen.
Run: scripts/lp-drill.sh --scenario sma_r08.

To add a node of this region (later batches): append its id to NODES, add a section to the probe, add a prove() line here, and put
`trace: drill("sma_r08")` on its line of evidence/r08.ts. Cores' nodes (`core:` anchors) are not proved here.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n674", "n675", "n678", "n682", "n683", "n684", "n685", "n686", "n687", "n688", "n689", "n690", "n691", "n692", "n695", "n696", "n697", "n698",
         "n699", "n700", "n701", "n702"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r08_probe.ts"
WINDOW_TEST = "tests/sma/four-proofs-r08-a2.test.tsx"


def scenario_sma_r08(tmp) -> dict:
    proofs = Proofs()
    # vite-node, not tsx: the probe loads the whole plugin's barrel files, which tsx cannot link.
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r08", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n674 The closed table: the call names are exactly the pinned list and every one has a registered handler.
    t = s["table"]
    proofs.prove("n674", t["same"] and t["count"] > 100 and t["unregistered"] == [], f"{t['count']} call names equal the pinned list; without a handler: {t['unregistered']}")
    # n675 Route match: an unknown name, an empty id and a stray field are refused; a well-formed call is answered.
    m = s["match"]
    ok = (m["unknown"] == 'plugin "lane-pilot" has no rpc method "no_such_door"' and m["noId"] == m["emptyId"] == m["stray"] == "rpc input validation failed"
          and m["good"] == {"on": True, "since": None, "reason": None})
    proofs.prove("n675", ok, f"unknown name -> {m['unknown']!r}; no id / empty id / stray field -> {m['noId']!r}; good call -> {m['good']}")
    # n678 Finish decisions on entry: the startup pass runs in the card's order with no merge grace; the periodic one keeps its grace and re-checks cancels.
    r = s["reconcile"]
    ok = (r["startup"] == ["merge-intents:0", "resume", "after-resume", "park", "parked-sweep", "wf-resume", "wf-poll"]
          and r["periodic"] == ["merge-intents:120000", "recheck-cancels", "park", "parked-sweep", "wf-resume", "wf-poll"]
          and r["broken"] == ["merge-intents:0", "resume", "park", "parked-sweep", "wf-resume", "wf-poll"])
    proofs.prove("n678", ok, f"startup {r['startup']}; periodic {r['periodic']}; a failing resume stops nothing: {r['broken']}")
    # n682 One action — one line: a read leaves none, a change leaves its name and argument keys, never the values.
    j = s["journal"]
    last = j["lines"][-1]
    proofs.prove("n682", j["beforeRead"] == j["afterRead"] and last == {"action": "conveyor", "keys": ["set", "reason"], "timed": True} and not j["leaksValue"],
                 f"lines before/after a read {j['beforeRead']}/{j['afterRead']}; the change left {last}; value leaked: {j['leaksValue']}")
    # n683 A door threw — named: failed in the log with the time, a refusal is called refused, the caller keeps the original error.
    w = s["threw"]
    proofs.prove("n683", w["logged"] == ["rpc broken 40 ms failed", "rpc refused 40 ms refused", "rpc fine 40 ms"] and w["errors"] == ["disk gone", "the owner gate"] and w["fine"] == {"ok": True},
                 f"log {w['logged']}; errors passed on {w['errors']}")
    # n684 The window ships with the plugin: the real app entry is loaded in the window test (it needs a DOM), and registers its three pages.
    ui = subprocess.run(["npx", "vitest", "run", WINDOW_TEST, "--maxWorkers=2"], cwd=ROOT, capture_output=True, text=True, timeout=300)
    passed = ui.returncode == 0 and "1 passed" in (ui.stdout + ui.stderr)
    proofs.prove("n684", passed, f"{WINDOW_TEST}: exit {ui.returncode}, {'1 passed' if passed else (ui.stdout + ui.stderr).strip()[-200:]}")
    # n685 Built window folder: the package names one app entry, it exists and defines the app; the package builds with bb plugin build.
    d = s["windowDir"]
    proofs.prove("n685", d["app"] == "./app.tsx" and d["appExists"] and d["definesApp"] and d["server"] == "./server.ts" and d["host"] == "./host.ts" and d["build"] == "bb plugin build",
                 f"app {d['app']} (exists {d['appExists']}, defines the app {d['definesApp']}), build script {d['build']!r}")
    # n686 Old roster page: every pre-regroup id resolves to its new tab; a current id stays; an unknown one lands on the overview.
    g = s["legacy"]
    ok = (g["resolved"] == g["table"] and g["table"]["memory"] == {"tab": "knowledge", "segment": "memory"} and g["table"]["monitor"] == {"tab": "runs", "segment": "board"}
          and all(g["current"]) and g["unknown"] == {"tab": "overview"})
    proofs.prove("n686", ok, f"{len(g['table'])} old ids resolved to {sorted({v['tab'] for v in g['table'].values()})}; unknown id -> {g['unknown']}")
    # n687 Action on another machine: the peer's id is the command's target and the call's route; the transport time is added to the command's limit.
    p = s["proxy"]
    ok = (p["calls"][0] == {"method": "runCommand", "input": {"requestedHostId": "mac-2", "command": "lane-coord status", "cwd": "/work/p", "timeoutSec": 20}, "options": {"hostId": "mac-2", "timeoutMs": 25000}}
          and p["calls"][1]["options"] == {"hostId": "hub", "timeoutMs": 777} and p["answer"]["hostId"] == "mac-2")
    proofs.prove("n687", ok, f"call to mac-2 {p['calls'][0]['options']}, to the hub {p['calls'][1]['options']}")
    # n688 Gate word never reaches peers: the owner's word calls are hub calls only, none is in the peers' closed list.
    f = s["proxyRefuse"]
    proofs.prove("n688", f["words"] == ["first_run_answer", "task_word", "workflow_answer"] and f["overlap"] == [] and f["wordNamed"] == [] and f["peerCount"] > 40,
                 f"word calls of the hub {f['words']}; among the peers' {f['peerCount']} methods: {f['overlap']}, word-named {f['wordNamed']}")
    # n689 Roster read: the stock team first in the product's order, then the owner's own with skills and connections.
    a = s["read"]
    ok = (a["stockOrder"] and a["stockNotCustom"] and a["created"].get("ok") and a["order"][-1] == "context-lead" and a["last"]["custom"] and a["last"]["skills"] == ["lane-memory"]
          and a["last"]["mcpServers"] == ["gitnexus"] and a["own"] == ["context-lead"])
    proofs.prove("n689", bool(ok), f"stock in the product's order {a['stockOrder']}; the owner's agent last: {a['last']['id']} skills {a['last']['skills']} connections {a['last']['mcpServers']}; custom filter {a['own']}")
    # n690 Worker toggle: a writer is switched off by profile key, provider/model or bare model id; another model and an empty list are not.
    o = s["toggle"]
    proofs.prove("n690", o["byKey"] == "glm-flash" and o["byPair"] == "codex/gpt-6-luna" and o["byModel"] == "some-unprofiled-model" and o["other"] is None and o["none"] is None,
                 f"by key {o['byKey']!r}, by pair {o['byPair']!r}, by model {o['byModel']!r}, another model {o['other']}, empty {o['none']}")
    # n691 Stock team: every stock id is recognised and reserved, a custom one is not, and a stock name cannot be taken by an owner's agent.
    k = s["stock"]
    ok = k["allStock"] and not k["custom"] and k["reservedStock"] and not k["reservedCustom"] and k["reserved"].get("error") == "agent_id_reserved" and k["kept"] == [False]
    proofs.prove("n691", ok, f"stock recognised {k['allStock']}, custom {k['custom']}, create under a stock name -> {k['reserved']}, listed custom flags {k['kept']}")
    # n692 Assign a skill to workers: the session opens with one line naming the picked skills, else the role's own and the note.
    l = s["skillLine"]
    ok = l["picked"] == "Your skills for this task: lp-writer, modern-web-guidance." and l["role"] == "Your skills for this task: lp-writer, karpathy-guidelines, and the skills Lane Pilot picked for this task."
    proofs.prove("n692", ok, f"picked: {l['picked']!r}; role default: {l['role']!r}")
    # n695 Machine connection register: the role profile says which connections a role gets; the owner's allow list replaces it.
    c = s["mcpRegistry"]
    ok = (c["writer"] == ["gitnexus"] and c["debuggerRole"] == ["gitnexus"] and c["critic"] == [] and c["writerHasGraph"] and not c["writerHasMeta"] and not c["criticHasGraph"]
          and "metamcp" in c["owned"] and "gitnexus" not in c["owned"] and c["all"] is None)
    proofs.prove("n695", ok, f"writer {c['writer']}, critic {c['critic']}; owner's allow list gives {c['owned']}; 'all' narrows nothing: {c['all']}")
    # n696 Switch a connection: a role's access stores names only — no command, args or url.
    mt = s["mcpToggle"]
    proofs.prove("n696", mt["stored"] == {"mode": "allow", "names": ["gitnexus", "metamcp"]} and mt["keys"] == ["mode", "names"], f"stored {mt['stored']}, keys {mt['keys']}")
    # n697 Conveyor switch: off keeps the first moment and a trimmed reason, is read back at once, off again changes nothing, on clears it.
    v = s["conveyor"]
    cd = s["conveyorDoor"]
    ok = (v["fresh"]["on"] and not v["off"]["on"] and v["off"]["reason"] == "deploy window" and v["read"] == v["off"] and v["againSame"] and v["on"] == {"on": True, "since": None, "reason": None}
          and cd["doorOff"]["on"] is False and cd["doorRead"]["reason"] == "night" and cd["doorOn"]["on"] is True)
    proofs.prove("n697", ok, f"off {v['off']}, read back {v['read']}, off again unchanged {v['againSame']}, on {v['on']}; through the door {cd['doorRead']}")
    # n698 Worker totals: done and not done counted from the window's attempts, an older one left out, attempts per accepted task.
    ws = s["workerStats"]
    proofs.prove("n698", ws["attempts"] == ["a1:accepted", "a2:failed", "a3:accepted", "a4:running", "a6:blocked"] and ws["total"] == 5 and ws["perAccepted"] == 2.5 and ws["doneSeconds"] == 120 and ws["runningSeconds"] is None,
                 f"attempts {ws['attempts']}, per accepted task {ws['perAccepted']}, finished attempt took {ws['doneSeconds']} s, a running one {ws['runningSeconds']}")
    # n699 Find the project's helpers: the run's machine is asked for every root; what parses is listed, the rest is not.
    sc = s["scan"]
    proofs.prove("n699", sc["rootsMatch"] and sc["host"] == "h1" and sc["skipOversized"] is True and sc["found"] == ["claude:agent:yard", "claude:skill:pick", "opencode:agent:scout", "codex:agent:ranger"],
                 f"found {sc['found']} on host {sc['host']}")
    # n700 Format parsers: Claude Code and OpenCode by front matter, Codex by TOML; a file without front matter or of a foreign tool is nothing.
    fm = s["formats"]
    ok = (fm["claude"]["format"] == "claude" and fm["claude"]["body"] == "Keep the yard tidy." and fm["opencode"] == {"source": ".opencode/agents/scout.md", "name": "scout", "description": "Scouts the repo.", "body": "Look around.", "format": "opencode", "kind": "agent"}
          and fm["opencodeSkill"]["name"] == "deep" and fm["codex"]["body"] == "Walk the trail." and fm["codex"]["format"] == "codex" and fm["noFront"] is None and fm["foreign"] is None)
    proofs.prove("n700", ok, f"claude {fm['claude']['format']}, opencode {fm['opencode']['format']}, codex {fm['codex']['format']}, no front matter {fm['noFront']}, foreign tool {fm['foreign']}")
    # n701 Take the chosen as drafts: each chosen into its kind's forge folder, written only if absent, previewed by the hash of the edits.
    en = s["enroll"]
    ok = (en["results"] == [{"name": "yard", "status": "applied"}, {"name": "pick", "status": "applied"}] and en["paths"] == [".agents/forge/roles/yard/yard.md", ".agents/forge/skills/pick/SKILL.md"]
          and en["cas"] == [None, None] and en["previewOk"] == [True, True] and en["roleHasModel"] and not en["skillHasModel"] and en["roleSource"])
    proofs.prove("n701", ok, f"results {en['results']}, paths {en['paths']}, written only if absent {en['cas']}")
    # n702 A name never overwrites: a safe slug; a clash is the named «kept» result; a failed write is named; every write is «only if absent».
    sl = s["slug"]
    ok = (sl["slugs"] == ["my-helper-x", "edge-case", 47] and sl["first"] == [{"name": "yard", "status": "applied"}] and sl["second"] == [{"name": "yard", "status": "kept: a draft with this name exists"}]
          and sl["third"] == [{"name": "yard", "status": "failed: host offline"}] and sl["allCas"])
    proofs.prove("n702", ok, f"slugs {sl['slugs']}; first {sl['first']}, clash {sl['second']}, failure {sl['third']}")
    return proofs.verdict("sma_r08", checked=len(NODES))
