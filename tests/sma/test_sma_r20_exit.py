"""The R20 scene must reject failed probes before reading their output."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from lp_drill.scenes import sma_r20


def probe_result():
    nine = sma_r20.NINE
    return {
        "status": {"exit": 0, "out": "thr_a thr_b claim ui: src/** claim docs: docs/** task t1 owns src/** collision: ui (thr_a) overlaps t1 (task)"},
        "heartbeat": {"live": ["thr_a"], "claims": ["ui"]},
        "claim": {"a": [0, "claimed ui:"], "b": [0], "taken": [1, "thr_a"]},
        "claims": ["docs:thr_b:docs/**", "ui:thr_a:src/**"],
        "release": {"verb": [1, "thr_a"], "a": [0, "released ui (abandoned)\nedits_left:"], "left": 0, "forged": [False, "not_holder", "thr_a"], "evidenceAfterForgery": 0, "records": ["docs:thr_b", "ui:thr_a"], "outcomeUi": [False, "abandoned"], "outcomeDocs": [True, "handed_off"], "filesUi": "src/app.ts", "baseUi": "ba5e123"},
        "forceClear": {"noReason": [1, 1], "fromChat": 1, "cleared": [0, "thr_a"], "takeover": 0, "now": ["ui:thr_b"], "holderRecord": "thr_a"},
        "ask": {"first": ["thr_writer", True, True], "repeat": True, "sentBeforeAnswer": 1, "intruder": "only the asked", "answer": ["thr_pm", True], "answeredAt": 1000000},
        "tia": {"alpha": True, "beta": False},
        "state": {"keepsHand": True, "outsideSame": True, "blockHasWal": ["manual: use WAL"], "parsed": ["manual: use WAL"], "stage": ["stage execution"], "personalHeading": True, "broken": True},
        "handoff": {"reason": True},
        "post": {"http": False, "https": True, "other": False, "posts": 1, "keys": nine, "projectId": "P", "leak": False},
        "sync": {"merged": ["merged", "merged"], "status": "synced", "head": True, "sawOther": True, "again": "up-to-date", "dirty": "dirty", "clash": ["conflict", True, True, True]},
        "registry": {"live": ["thr_a", "thr_b"], "provider": "claude-code", "afterTtl": 0},
        "race": {"winners": 1, "loser": "claim_taken", "kept": 1, "invalid": "invalid_glob", "afterInvalid": ["api"]},
        "collision": {"hits": [{"a": "ui", "b": "page", "kind": "claim"}, {"a": "ui", "b": "t1", "kind": "task"}], "bad": []},
        "slots": {"locked": True, "appendOk": True, "middle": "does not match the recorded statement"},
        "fingerprint": {"branch": "feat", "n": 50},
        "gate": {"stale": ["failed", True, True], "fresh": "merged", "landed": True},
        "capsule": {"asks": ["ask 4", "ask 5", "ask 6", "ask 7", "ask 8"], "askLen": [300], "files": 30, "claims": 30},
        "body": {"keys": nine, "title": 200, "attempt": 3, "extra": []},
        "notify": {"events": ["owner.waiting", "pulse"], "projects": ["P", "P"], "at0": 123, "at1Recent": True, "keys": nine},
        "digest": {"kpi": {"accepted": 2, "blocked": 1, "running": 0, "tokens": 0, "actions": 1}, "partial": [], "rearmSame": True, "downPartial": ["actions"], "downKpi": {"accepted": 2, "actions": 0}, "downFeed": 3, "logged": "source actions failed: front down"},
        "wide": ["tests/t0.test.ts", "tests/t1.test.ts"],
        "translit": {"given": "F-7", "english": "src/a.ts:missing-null-check", "russian": ["src/a.ts:abcdef", "src/a.ts:123456"], "hash": "abcdef", "noFile": "finding:slow-path"},
        "atomic": {"locked": [5, "denied"], "missing": [1, "gone"], "flaky": [3, "ok"]},
        "lease": {"provider": "claude-code", "label": "mine", "claims": [["ui", "src/**", 300, "deadbeef", "thr_a"]], "refreshed": True, "afterExpiry": [0, ["fresh"]]},
        "trail": ["bare:thr_b:base=unknown|files=none|outcome=handed_off", "ui:thr_a:base=ba5e123|files=src/a.ts, src/b.ts|outcome=committed"],
        "flight": {"files": 30, "last": "src/f29.ts", "claims": 30, "restoredHead": "Capsule restored after compaction:", "task": True, "capped": True},
    }


class R20ProbeExitTest(unittest.TestCase):
    def test_nonzero_rejected_before_json_parsing(self):
        for output in (json.dumps(probe_result()), "{malformed"):
            with self.subTest(output=output[:20]), patch.object(sma_r20.subprocess, "run", return_value=SimpleNamespace(returncode=7, stdout=output, stderr="probe failed")), patch.object(sma_r20.json, "loads", side_effect=AssertionError("nonzero output parsed")):
                verdict = sma_r20.scenario_sma_r20(Path("."))
                self.assertEqual(verdict["result"], "fail")
                self.assertEqual(verdict["proved"], [])
                self.assertIn("probe exited 7: probe failed", verdict["problems"][0])

    def test_zero_exit_preserves_success_and_failures(self):
        data = probe_result()
        for output, expected in ((json.dumps(data), "pass"), ("{malformed", "fail")):
            with self.subTest(expected=expected), patch.object(sma_r20.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=output, stderr="")):
                verdict = sma_r20.scenario_sma_r20(Path("."))
                self.assertEqual(verdict["result"], expected, verdict["problems"])
                if expected == "pass":
                    self.assertEqual(len(verdict["proved"]), len(sma_r20.NODES))
                else:
                    self.assertIn("printed no result (exit 0)", verdict["problems"][0])
        data["heartbeat"]["claims"] = []
        with patch.object(sma_r20.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(data), stderr="")):
            verdict = sma_r20.scenario_sma_r20(Path("."))
            self.assertEqual(verdict["result"], "fail")
            self.assertTrue(any("n1518" in problem for problem in verdict["problems"]))


if __name__ == "__main__":
    unittest.main()
