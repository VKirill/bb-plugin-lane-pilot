"""Region 1 · Task graph, batch h: attempt failure consumers and acceptance barriers.

The companion probe invokes the real consumer entrypoints on fake-host, scratch
SQLite worlds.  It never starts a hub, a live scene, or a model.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES_H = ["n160", "n172", "n175", "n185", "n201", "n207", "n208", "n217", "n259", "n260", "n270"]
PROBE_H = ROOT / "scripts/lp_drill/scenes/sma_r01_h_probe.ts"


def prove_h(proofs: Proofs, tmp: Path) -> None:
    del tmp
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE_H)], cwd=ROOT, capture_output=True, text=True, timeout=900)
    try:
        observed = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES_H:
            proofs.prove(node, False, f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if not isinstance(observed, dict):
        for node in NODES_H:
            proofs.prove(node, False, f"the probe printed a non-object result: {observed!r}")
        return
    if done.returncode != 0:
        for node in NODES_H:
            proofs.prove(node, False, f"the probe exited {done.returncode} despite printing JSON: {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if "fatal" in observed:
        for node in NODES_H:
            proofs.prove(node, False, f"the probe failed: {observed['fatal']}")
        return

    def value(node: str):
        result = observed.get(node)
        if isinstance(result, dict) and "error" in result:
            proofs.prove(node, False, f"the probe step failed: {result['error']}")
            return None
        if not isinstance(result, dict) or not result:
            proofs.prove(node, False, f"the probe returned no usable observation: {result!r}")
            return None
        return result

    def mapping(result: dict, key: str) -> dict:
        nested = result.get(key)
        return nested if isinstance(nested, dict) else {}

    v = value("n160")
    if v is not None:
        proofs.prove("n160", v.get("seen") == [["at spawn", "spawn_requested", None], ["at reconcile", "spawn_unknown", "fetch failed"]]
                     and v.get("result") == {"ok": True, "threadId": "thr_found"}, f"spawn intent/reconcile {v}")
    v = value("n172")
    if v is not None:
        proofs.prove("n172", v == {"state": "validation_failed", "reason": "verification failed (npm test): boom", "failureCode": "verification_failed", "checkName": "npm test"}, f"failure row {v}")
    v = value("n175")
    if v is not None:
        proofs.prove("n175", v.get("family") == [[1, "validation_failed", "owns_paths: src/x.ts is outside the contract"]]
                     and v.get("current") == [[1, "blocked"]]
                     and isinstance(v.get("reason"), str) and v["reason"].startswith("repeated_failure: owns_paths: src/x.ts is outside the contract"), f"real family-failure route stopped the repeated ownership failure {v}")
    v = value("n185")
    if v is not None:
        done, row, request = mapping(v, "done"), mapping(v, "row"), mapping(v, "request")
        proofs.prove("n185", done.get("ok") is True and done.get("oldThreadId") == "thr_old" and done.get("oldAttemptNo") == 1 and done.get("providerId") == "codex" and done.get("model") == "codex-test"
                     and row == {"state": "cancel_requested", "cancel_code": "reassign"}
                     and request == {"reason": "use the narrower reading", "selection": {"providerId": "codex", "model": "codex-test"}}, f"reassign consumer {v}")
    v = value("n201")
    if v is not None:
        result, attempt = mapping(v, "result"), mapping(v, "attempt")
        proofs.prove("n201", result.get("status") == "validation_failed"
                     and isinstance(result.get("reason"), str) and result["reason"].startswith("verification failed (check): environment: ")
                     and attempt == {"state": "validation_failed", "failureCode": "verification_failed", "checkName": "check"}, f"finish classified environment failure {v}")
    v = value("n207")
    if v is not None:
        proofs.prove("n207", v == {"busy": "spawn_rejected", "free": 1, "state": "validation_failed", "class": "limit"}, f"spawn failure was free, real failure charged {v}")
    v = value("n208")
    if v is not None:
        proofs.prove("n208", v.get("state") == "queued" and isinstance(v.get("reason"), str) and v["reason"].startswith("waiting_writer:") and v.get("wakeAt") == 1800000000000, f"writer hold parked at earliest wake {v}")
    v = value("n217")
    if v is not None:
        proofs.prove("n217", v == {"state": "blocked", "reason": "writer_provider_unavailable:core_unsupported:devin", "wakeAt": None}, f"unsupported chain blocked without wake {v}")
    v = value("n259")
    if v is not None:
        proofs.prove("n259", v.get("family") == [[1, "validation_failed", "verification failed (npm test): repeated tree failure"]]
                     and v.get("current") == [[1, "blocked"]]
                     and isinstance(v.get("reason"), str) and v["reason"].startswith("repeated_failure: verification failed (npm test): repeated")
                     and v.get("different", {}).get("family") == [[1, "validation_failed", "verification failed (npm test): first fault"]]
                     and v.get("different", {}).get("current") == [[2, "accepted"]], f"real family-failure route stopped the repeated failure without blocking a different fingerprint {v}")
    v = value("n260")
    if v is not None:
        asked, not_asked, allowed = mapping(v, "asked"), mapping(v, "notAsked"), mapping(v, "allowed")
        proofs.prove("n260", asked.get("state") == "blocked" and isinstance(asked.get("reason"), str) and asked["reason"].startswith("test_edit_hold:")
                     and asked.get("held") == [{"path": "tests/sum.test.ts", "afterSha256": v.get("afterSha")}]
                     and not_asked.get("state") == "validation_failed" and allowed.get("held") == [], f"test edit barrier/receipt {v}")
    v = value("n270")
    if v is not None:
        result, attempt, receipt = mapping(v, "result"), mapping(v, "attempt"), mapping(v, "receipt")
        barrier = mapping(attempt, "barrier")
        proofs.prove("n270", result.get("status") == "blocked" and attempt.get("state") == "blocked"
                     and attempt.get("reason") == result.get("reason") and receipt.get("state") == "blocked"
                     and barrier.get("gate") == "accept", f"critic block barrier/receipt {v}")
