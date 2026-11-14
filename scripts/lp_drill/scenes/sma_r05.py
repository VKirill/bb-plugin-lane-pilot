"""Region 5 · Daemon life: the region scene of the SMA-parity proof (docs/sma-evidence.md, «Trace choice»).

The cards describe the old daemon process (start, boot order, stop, recovery); each node is proved by the part of Lane Pilot that serves it now. The probe
(sma_r05_probe.test.ts, run by vitest) boots the plugin factory on the SDK's fake host, runs the start-up recovery service, disposes the plugin, and runs the
units (the queue, the ledger, the breaker, the sweeps) on scratch SQLite databases; it reads the effect from the database, the host calls and the key-value
store. No model, no hub, no network; the real code of the checkout under drill. The scene compares each value with the node card's expected result.
Nodes n469 (the window link) and n470 (the start failure text) are proved in bb-core, not here; n458 is a deviation and n464, n478 and n485 are void.

To add a node of this region: put its observed value in a section of the probe, add its prove() line below and the id to NODES.
Run: scripts/lp-drill.sh --scenario sma_r05   (add --dry-run to list the nodes). It is model-free, so it runs anywhere the checkout has node_modules.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = [f"n{n}" for n in (440, 441, 442, 443, 444, 445, 446, 447, 448, 449, 450, 451, 452, 453, 454, 455, 456, 457, 459, 460, 461, 462, 463, 465, 466, 467, 468, 471)]
CONFIG = "scripts/lp_drill/scenes/sma_r05.vitest.config.ts"


def _get(seen: dict, section: str) -> dict:
    """One probe section; an errored or missing one is returned as {} so every node of it fails with the section's error in its detail."""
    value = seen.get(section)
    return value if isinstance(value, dict) and "error" not in value else {}


def _why(seen: dict, section: str) -> str:
    value = seen.get(section)
    return f"section {section} did not run: {value.get('error') if isinstance(value, dict) else 'missing'}"


def scenario_sma_r05(tmp: Path) -> dict:
    proofs = Proofs()
    out = tmp / "sma_r05_probe.json"
    done = subprocess.run(["npx", "vitest", "run", "--config", CONFIG], cwd=ROOT, capture_output=True, text=True, timeout=900, env={**os.environ, "SMA_R05_OUT": str(out)})
    try:
        seen = json.loads(out.read_text())
    except (OSError, ValueError):
        return proofs.verdict("sma_r05", [f"the probe wrote no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-400:]}"])

    def prove(node: str, section: str, check, detail, sub: str | None = None) -> None:
        data = _get(seen, section)
        if data and sub is not None:
            data = data.get(sub)
        if not data:
            proofs.prove(node, False, _why(seen, section) if not _get(seen, section) else f"section {section}.{sub} is empty")
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n440 Entry: before the factory is called nothing is registered; the call registers the door and says the pipeline is loaded.
    prove("n440", "boot", lambda d: d["loaded"] and d["rpc"] > 0 and all(v == 0 for v in d["before"].values()), lambda d: f"before the call {d['before']}; after it {d['rpc']} RPC methods, start line logged {d['loaded']}", "entry")
    # n441 Death with a name: a gap 29 minutes after an orderly stop carries the stop's words; a gap after a silent end says it stopped without warning.
    prove("n441", "gaps", lambda d: d["gaps"][0].endswith("the plugin was reloaded (a deploy or a settings change)") and "без предупреждения" in d["gaps"][1], lambda d: f"gaps on record: {d['gaps']}")
    # n442 Root of the build: one call gives the schema, every method of the contract, the CLI, the tools and the tick wiring.
    prove("n442", "boot", lambda d: d["tables"] and d["missingRpc"] == [] and d["cli"] and d["tools"] > 0 and d["tickDeps"]["missing"] == [], lambda d: f"schema {d['tables']}, contract methods missing {d['missingRpc']}, tools {d['tools']}, tick deps wired {len(d['tickDeps']['wired'])}", "compose")
    # n443 One copy of settings: a run keeps the policy it was created with; a later run gets its own.
    prove("n443", "policy", lambda d: d["kept"] == d["frozen"] and d["frozen"]["pools"]["provider"] == 7 and d["second"] == 2, lambda d: f"run one keeps {d['kept']['pools']}; run two gets provider pool {d['second']}")
    # n444 Passport: the canary, the attempt stamp and package.json carry one version.
    prove("n444", "passport", lambda d: d["canary"] == d["stamped"] == d["pkg"], lambda d: f"canary {d['canary']}, attempt stamp {d['stamped']}, package {d['pkg']}")
    # n445 Queue in the database: the plugin's SQLite takes settings writes through the validator the opener wired; an opener without one is refused.
    prove("n445", "queue", lambda d: d["wired"] and d["unwired"] == "no validator", lambda d: f"validator wired {d['wired']}; without one: {d['unwired']}")
    # n446 One attempts ledger: attempts come in order with their journal.
    prove("n446", "ledger", lambda d: d["attempts"] == ["a_first:1:blocked", "a_second:2:queued"] and d["journal"] == ["spawn_requested", "running", "blocked"], lambda d: f"attempts {d['attempts']}, journal {d['journal']}")
    # n447 Three wrappers: a task write lands with its journal row and the world counter in one frame.
    prove("n447", "ledger", lambda d: d["taskJournal"] == ["created"] and d["seq"] == 1, lambda d: f"task journal {d['taskJournal']}, world seq {d['seq']}")
    # n448 World version: each write of an attempt raises it by one; a repeated move raises nothing.
    prove("n448", "world", lambda d: d["steps"] == [1, 1, 0], lambda d: f"steps per write {d['steps']}")
    # n449 One board derivation: two requests at once get the same board, newest first.
    prove("n449", "boot", lambda d: d["first"] == ["t_new", "t_old"] and d["same"] and d["direct"] == d["first"], lambda d: f"board {d['first']}, identical for two requests {d['same']}", "board")
    # n450 Front server: the door answers the canary, the conveyor and the world number from the built capabilities.
    prove("n450", "boot", lambda d: d["missing"] == 0 and d["canary"]["green"] is True and d["conveyor"]["on"] is True and d["world"]["version"] == d["expectWorld"], lambda d: f"missing methods {d['missing']}, canary green {d['canary']['green']}, conveyor on {d['conveyor']['on']}, world {d['world']['version']}", "front")
    # n451 Tick wiring: a bag with services missing names all of them, a full bag names none.
    prove("n451", "tickDeps", lambda d: d["empty"] == d["total"] and d["full"]["missing"] == [], lambda d: f"empty bag misses {d['empty']} of {d['total']}, full bag misses {d['full']['missing']}")
    # n452 Tick: the board tick is a core schedule, every minute, isolated, skipping an overlap, with a time limit.
    prove("n452", "isolated", lambda d: d["calls"][0]["options"].get("isolated") is True and d["calls"][0]["options"].get("overlap") == "skip" and d["calls"][0]["options"].get("timeoutMs") == 120000, lambda d: f"registered {d['calls']}")
    # n453 Load order: migrations, the door, the schedules, the recovery service last; the version's first start is stamped.
    order, started = _get(seen, "boot").get("order"), _get(seen, "recovery")
    proofs.prove("n453", bool(order and started) and 0 == order["migrate"] < order["door"] < order["sweep"] < order["service"] and started["canarySince"] == "number", f"order {order}, canary start stamp {started.get('canarySince')}")
    # n454 Folders before writes: every migration is applied in one call before any write.
    prove("n454", "migrate", lambda d: d["calls"] == 1 and d["all"] and d["count"] > 0, lambda d: f"migrate calls {d['calls']}, all {d['count']} migrations passed {d['all']}")
    # n455 Queue first: from the first enqueue a task for a missing run is refused.
    data = seen.get("boot", {}) if isinstance(seen.get("boot"), dict) else {}
    proofs.prove("n455", data.get("fk") == "refused: foreign key", f"orphan task: {data.get('fk')}")
    # n456 Door before passes: the door has all its methods when the recovery sweep first touches a copy.
    prove("n456", "recovery", lambda d: d["deleted"] and d["deleted"][0].endswith(f"@rpc{d['doorMethods']}") and d["doorMethods"] > 0, lambda d: f"copy removed {d['deleted']} with the door at {d['doorMethods']} methods")
    # n457 Process record: process number, runtime and start time.
    prove("n457", "gaps", lambda d: d["record"] == {"startedAt": 1700000000000, "pid": d["pid"], "node": d["node"]}, lambda d: f"record {d['record']}")
    # n459 Who gets no work: three tasks on one fault hold the project (not before the third), the hold names the fault, another project is free.
    prove("n459", "breaker", lambda d: d["early"] is None and "attempt_worktree_holder_ambiguous" in (d["held"] or "") and d["other"] is None, lambda d: f"after two {d['early']}, after three «{str(d['held'])[:80]}», other project {d['other']}")
    # n460 Last daemon's tasks finished: a dispatch with live helpers resumes, one without is blocked with the reason.
    prove("n460", "orphans", lambda d: d["result"]["resumed"] == ["a_live"] and d["result"]["skipped"] == ["a_half"] and d["half"]["state"] == "blocked" and "send the task again" in d["half"]["reason"] and d["live"] == "queued", lambda d: f"result {d['result']}, half-done {d['half']['state']}")
    # n461 Worker copy cleanup: saved first, then archive and delete; a copy whose save failed stays.
    prove("n461", "sweep", lambda d: d["saved"]["events"] == ["snapshot:/wt/env_1", "archive", "delete:env_1"] and d["failed"]["removed"] == [] and d["failed"]["events"] == ["snapshot:/wt/env_1"], lambda d: f"saved: {d['saved']['events']}; failed save: {d['failed']['events']}")
    # n462 Confirm later: a cancel is rechecked only after a minute and only once the thread is idle; then the attempt is settled.
    prove("n462", "cancels", lambda d: d["whileActive"] == [] and d["whenIdle"] == ["att_old"] and d["young"] == "cancel_requested", lambda d: f"recheck while active {d['whileActive']}, when idle {d['whenIdle']}, young cancel {d['young']}")
    # n463 Forced old-copy sweep: at the start the old finished copy goes (with its save), the recent one stays.
    prove("n463", "recovery", lambda d: [x.split("@")[0] for x in d["deleted"]] == ["env_done"] and d["snapshots"] == 1, lambda d: f"removed {d['deleted']}, saves {d['snapshots']}")
    # n465 Settings without restart: the next read sees a change; a project's own value beats the shared one.
    prove("n465", "settings", lambda d: d["shared"] == 9 and d["own"] == 4 and d["other"] == 9 and d["changed"] == 6, lambda d: f"shared {d['shared']}, own {d['own']}, other project {d['other']}, after a change {d['changed']}")
    # n466 Said aloud: a conveyor left off is said at the start with the way out; nothing while it is on.
    prove("n466", "conveyor", lambda d: d["onLine"] is None and len(d["said"]) == 1 and "bb lane-pilot conveyor on" in d["said"][0], lambda d: f"on: {d['onLine']}; off at start: {d['said']}")
    # n467 Green only when the pool works: a held writer pool is not green; a free one is.
    prove("n467", "pool", lambda d: d["held"] is False and d["free"] is True, lambda d: f"held pool green {d['held']}, free pool green {d['free']}")
    # n468 Not green: writers blocked: the blocked provider is named with its project and reason.
    prove("n468", "pool", lambda d: d["enabled"] == 2 and d["blocked"] == ["codex/gpt|proj|writer_provider_unavailable:breaker_open"], lambda d: f"blocked {d['blocked']}")
    # n471 Orderly stop: the stop writes its name, and the next start's gap carries it.
    prove("n471", "boot", lambda d: d["reason"] == "the plugin was reloaded (a deploy or a settings change)" and d["next"] == [d["reason"]], lambda d: f"stop reason «{d['reason']}», next start's gap {d['next']}", "stop")
    return proofs.verdict("sma_r05", checked=len(NODES))
