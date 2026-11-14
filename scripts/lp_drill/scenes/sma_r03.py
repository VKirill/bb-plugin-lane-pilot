"""Region 3 · Worker (batch a): the worker's boundaries, capability gates, separate user, and roles, proved on the commit under drill.

A scene named sma_rNN proves map nodes of region NN (docs/sma-evidence.md, «Trace choice»). It runs the REAL code of the commit under drill (no model turn,
no hub write: temporary folders, a fake plugin host, a scratch database, a fake sudo/setfacl) and, per node, calls proofs.prove(node, ok, detail)
with the result the node's card expects and what was actually seen. Only a node the scene lists with ok true counts as a drill trace.
Run: scripts/lp-drill.sh --scenario sma_r03. The probe (sma_r03_probe.ts) runs under vitest (the rooms import each other in cycles plain tsx rejects)
and writes one JSON file; this scene judges it. Nodes n397 and n405 are traced by the task_home drill, n389..n395, n406 and n410 by hub rows, n407 by the
plan workflow: they are not here. Settings that are off on the hub (worker.strict_user, the bubblewrap sandbox) are exercised on stand-ins, never flipped.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n383", "n384", "n385", "n386", "n387", "n388", "n396", "n398", "n399", "n400", "n401", "n402", "n403", "n404", "n408", "n409", "n411", "n412", "n413", "n414"]
CONFIG = "scripts/lp_drill/scenes/sma_r03.vitest.config.ts"


def scenario_sma_r03(tmp: Path) -> dict:
    proofs = Proofs()
    out = tmp / "sma_r03_probe.json"
    done = subprocess.run(["npx", "vitest", "run", "--config", CONFIG], cwd=ROOT, capture_output=True, text=True, timeout=900, env={**os.environ, "SMA_R03_OUT": str(out)})
    try:
        seen = json.loads(out.read_text())
    except (OSError, ValueError):
        return proofs.verdict("sma_r03", [f"the probe wrote no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-400:]}"])

    def prove(node: str, check, detail) -> None:
        data = seen.get(node)
        if data is None or (isinstance(data, dict) and list(data) == ["threw"]):
            proofs.prove(node, False, f"the probe section did not run: {data}")
            return
        try:
            ok = bool(check(data))
        except (KeyError, IndexError, TypeError):
            ok = False
        proofs.prove(node, ok, detail(data))

    # n383 Envelope: eight dimensions, each naming how it is enforced; the files that are named exist.
    def envelope(d):
        paths = re.findall(r"\((?:[^()]*? )?((?:src|packages)/[A-Za-z0-9_./-]+)", d["files"])
        return len(d["keys"]) == 8 and paths == ["src/rooms/verification/git-ownership.ts"] and all((ROOT / p).exists() for p in paths)
    prove("n383", envelope, lambda d: f"dimensions {d['keys']}; files law: {d['files'][:90]}")
    # n384 Denials ride the launch: a writer's launch denies push, merge, tag and release; a PM's does not.
    prove("n384", lambda d: all(d["writerDenies"].values()) and not any(d["pmDenies"].values()), lambda d: f"writer denies {d['writerDenies']}, PM denies {d['pmDenies']}")
    # n385 Its own threshold: the guard names the danger of a writer's call (and only names).
    prove("n385", lambda d: d["writerClean"] == ["worker_clean_force"] and d["writerReset"] == ["worker_reset_hard"], lambda d: f"clean -> {d['writerClean']}, reset --hard -> {d['writerReset']}")
    # n386 A ticket stands ten minutes: a fresh one is listed and answerable, one 601 s old is neither.
    prove("n386", lambda d: d["listed"] == ["ffffffffffffffff"] and d["freshAnswer"]["written"] and d["freshAnswerFile"] and d["staleAnswer"].get("expired") and not d["staleAnswerFile"],
          lambda d: f"listed {d['listed']}, stale answer {d['staleAnswer']}, fresh answer {d['freshAnswer']}")
    # n387 The decision rides «queue-if-active» to the writer's own thread, and the host gets exactly the decision given.
    prove("n387", lambda d: [r["hostGot"]["decision"] for r in d] == ["allow", "deny"] and all(r["sentMode"] == "queue-if-active" and r["sentTo"] == "writer-b" for r in d)
          and [r["returned"]["decision"] for r in d] == ["allow", "deny"], lambda d: f"host told {[r['hostGot']['decision'] for r in d]}, writer told in mode {[r['sentMode'] for r in d]}: {d[1]['text']}")
    # n388 The table: a provider without a version is unproven in every cell; a receipt for its version is its state.
    prove("n388", lambda d: set(d[0]["capabilities"].values()) == {"unproven"} and d[1]["capabilities"]["pause"] == "supported" and d[1]["capabilities"]["answers"] == "unproven",
          lambda d: f"{[(r['providerId'], r['version']) for r in d]}; codex pause {d[1]['capabilities']['pause']}")
    # n396 The separate user: create makes the user and a sudoers rule for the owner only, no password; check reads reachability by exit code.
    prove("n396", lambda d: d["rule"] == "owner ALL=(lp-sma-r03-user) NOPASSWD:SETENV: ALL\n" and d["checkReachable"]["code"] == 0 and d["checkUnreachable"]["code"] == 1
          and d["badName"]["code"] == 2 and not any("passwd" in c for c in d["createCalls"]), lambda d: f"rule {d['rule']!r}, check reachable {d['checkReachable']['code']}, unreachable {d['checkUnreachable']['code']}, bad name {d['badName']['code']}")
    # n398 The launch: sudo as the user, keeping only the named variables; an invalid name is refused.
    prove("n398", lambda d: d["args"] == {"program": "/usr/bin/sudo", "args": ["-n", "-u", "lp-worker", "--preserve-env=A,B", "/bin/echo", "hi"]} and "worker_user_invalid" in d["threw"], lambda d: f"{d['args']['args']}; bad name: {d['threw']}")
    # n399 The folders: exactly the one granted is listed with user and owner; the refused one is not.
    prove("n399", lambda d: d["granted"] == ["<run>"] and len(d["ledger"]) == 1 and d["ledger"][0]["user"] == "lp-worker" and len(d["calls"]) == 2, lambda d: f"granted {d['granted']}, ledger {d['ledger']}")
    # n400 Checks run as the worker: strict_user on sends the user, off sends none.
    prove("n400", lambda d: d["on"] and all(i.get("asUser") == "lp-worker" for i in d["on"]) and d["off"] and all("asUser" not in i for i in d["off"]), lambda d: f"on -> {[i.get('asUser') for i in d['on']]}, off -> {[i.get('asUser') for i in d['off']]}")

    # n401 One command, one answer: the backend is chosen by platform; a missing bubblewrap is a refusal, not a silent unconfined run; a write outside is refused.
    def confined(d):
        run = d["run"]
        base = d["resolved"] == ["linux-bubblewrap", "macos-seatbelt"] and "sandbox_backend_unavailable" in d["missing"]
        return base and (run is None or (run["answer"]["exitCode"] == 0 and run["answer"]["stdout"] == "one-answer\n" and run["failing"]["exitCode"] == 3 and run["timedOut"] == 124
                                        and run["outside"]["created"] is False and run["outside"]["exitCode"] != 0 and run["inside"]["created"] is True))
    prove("n401", confined, lambda d: f"backends {d['resolved']}; missing: {d['missing']}; confined run {'skipped (no bubblewrap)' if d['run'] is None else d['run']['answer']}")
    # n402 The critic reads the attempt's own copy: the newest environment at that path, nothing for another path or none.
    prove("n402", lambda d: d == {"atWorktree": {"type": "reuse", "environmentId": "env_new"}, "otherPath": None, "noEnvironment": None}, lambda d: json.dumps(d))
    # n403 Receipts reach the task home in the base checkout, once, and only there.
    prove("n403", lambda d: d["acceptancePath"].endswith("/.agents/tasks/t1/acceptance.json") and d["receiptPath"].endswith("/.agents/tasks/t1/receipt.json") and d["onlyBase"] and d["acceptance"] == '{"ok":true}\n',
          lambda d: f"{d['acceptancePath']}, {d['receiptPath']}, only in the base {d['onlyBase']}")
    # n404 Never a pass without proof: a bad name and a user that does not exist are both unreachable.
    prove("n404", lambda d: d == {"invalid": False, "unknown": False}, lambda d: json.dumps(d))
    # n408 The drawing step is led by design-lead, not the writer.
    prove("n408", lambda d: "draw:specialist:design-lead" in d and not any(x.endswith(":writer") for x in d), lambda d: f"roles of lp.draw {d}")
    # n409 The critic is an ordinary roster worker on the attempt's own copy; approval passes, with a passed receipt.
    prove("n409", lambda d: d["allowed"] is True and d["role"] == "code-critic" and d["environment"] == {"type": "reuse", "environmentId": "env_wt"} and d["receipt"] == "passed", lambda d: json.dumps(d))
    # n411 The Creator writes exactly one draft and is told what it must never grant.
    prove("n411", lambda d: "exactly one skill draft" in d and "Never grant: permission bypass, every tool" in d and "cell-sum/SKILL.md" in d, lambda d: d[:120])
    # n412 A lane per vendor: claude-code and codex narrow four groups, the others three.
    prove("n412", lambda d: d["claude-code"] == d["codex"] == ["bbPlugins", "skills", "mcpServers", "nativePlugins"] and d["opencode2"] == ["bbPlugins", "skills", "mcpServers"], lambda d: json.dumps(d))
    # n413 Roles default to the top model and its effort; an owner's pick replaces it; a pick without an effort takes the model's own.
    prove("n413", lambda d: d["plannerDefault"]["model"] == "claude-opus-5-5" and d["plannerDefault"]["effort"] == "high" and d["ownerPickNoEffort"]["effort"] == "medium"
          and d["ownerPickNoEffort"]["source"] == "table" and d["ownerPickWithEffort"]["effort"] == "xhigh", lambda d: f"planner {d['plannerDefault']['model']}/{d['plannerDefault']['effort']}, pick without effort {d['ownerPickNoEffort']['effort']}, with {d['ownerPickWithEffort']['effort']}")
    # n414 An exhausted window is a wait: saturation, a spent quota and an open breaker are limits, a plain failure is not.
    prove("n414", lambda d: d == {"capacity": True, "quota": True, "breaker": True, "plain": False}, lambda d: json.dumps(d))
    return proofs.verdict("sma_r03", checked=len(NODES))
