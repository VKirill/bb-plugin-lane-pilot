"""Region phase-trace gaps: model-free observations of existing phase/workflow fixtures.

The TypeScript probe runs the real logic and the phase driver against scratch state.
This scene deliberately proves only the requested cards; the parent scene owns the
region aggregators and any shared evidence rows.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n264", "n324", "n327", "n347", "n350", "n356", "n357", "n359", "n361", "n367", "n368", "n371", "n372", "n381", "n382", "n1128", "n1590", "n1606", "n1607", "n1624", "n1684"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_phase_traces_probe.ts"


def prove_phase_traces(proofs, tmp) -> None:
    done = subprocess.run(["npx", "--yes", "vite-node", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=420)
    if done.returncode != 0:
        for node in NODES:
            proofs.prove(node, False, f"probe exited {done.returncode}: {(done.stderr or done.stdout).strip()[-300:]}")
        return
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        for node in NODES:
            proofs.prove(node, False, f"probe printed no JSON (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}")
        return
    if not isinstance(seen, dict):
        for node in NODES:
            proofs.prove(node, False, f"probe root is not an object: {type(seen).__name__}")
        return

    # Negative guard: a typo in this scene's card list must never silently make a
    # missing observation look proved.
    missing = [node for node in NODES if node not in seen]

    def check(node: str, predicate, detail) -> None:
        value = seen.get(node)
        try:
            ok = node not in missing and bool(predicate(value))
            detail_text = detail(value) if value is not None else f"observation {node} returned null"
        except (KeyError, IndexError, TypeError, AttributeError):
            ok = False
            detail_text = f"observation {node} malformed: {value!r}"
        proofs.prove(node, ok, detail_text)

    check("n264", lambda d: d.get("approved", {}).get("allowed") is True and d.get("approved", {}).get("state") == "passed" and d.get("blocked", {}).get("allowed") is False and d.get("environment") == {"type": "reuse", "environmentId": "env_wt"},
          lambda d: f"critic approved={d.get('approved')}, blocked={d.get('blocked')}")
    check("n324", lambda d: d.get("first", {}).get("ok") is True and d.get("second", {}).get("ok") is False and "already decided" in d.get("second", {}).get("reason", "") and d.get("row", {}).get("state") == "closed" and d.get("row", {}).get("closed_by", "").startswith("approved:"), lambda d: f"decision claim={d}")
    check("n327", lambda d: d.get("paused") == "paused" and d.get("resumed") == "active", lambda d: f"pause={d.get('paused')}, resume={d.get('resumed')}")
    check("n347", lambda d: d.get("state") == "failed" and "goal check failed" in d.get("detail", ""), lambda d: f"verdict={d.get('state')}, detail={d.get('detail')}")
    check("n350", lambda d: d.get("key") == "execution:word:issue" and d.get("waitsForPm") is True, lambda d: f"next action={d.get('key')}, waits={d.get('waitsForPm')}")
    check("n356", lambda d: d == {"yes": 1, "stage": "design", "redrawn": True, "archived": [True], "designWords": 0, "asksAgain": True, "book": [True]}, lambda d: f"real drawing editions/hash/archive/word invalidation={d}")
    check("n357", lambda d: d.get("noKey", "") and d.get("wrongKey", "") and d.get("afterWord", {}).get("confirmed") is True, lambda d: f"key refusals={d.get('noKey')!r}/{d.get('wrongKey')!r}, confirmed={d.get('afterWord')}")
    check("n359", lambda d: d == ["a", "b"], lambda d: f"issuable pieces={d}")
    check("n361", lambda d: d.get("afterFirst", {}).get("issued") == {"a": "a"} and d.get("changed", {}).get("secondId") == "a.2", lambda d: f"first={d.get('afterFirst')}, changed={d.get('changed')}")
    check("n367", lambda d: "not stopped" in d.get("refused", "") and d.get("skipped") == ["b"] and d.get("withdrawn") == ["a"], lambda d: f"refusal={d.get('refused')}, skipped={d.get('skipped')}, withdrawn={d.get('withdrawn')}")
    check("n368", lambda d: d.get("remaining") == ["a"] and d.get("withdrawn") == ["b"], lambda d: f"remaining={d.get('remaining')}, withdrawn={d.get('withdrawn')}")
    check("n371", lambda d: d.get("canceled") == ["queued"] and d.get("state") == "paused", lambda d: f"canceled={d.get('canceled')}, state={d.get('state')}")
    check("n372", lambda d: d.get("issueWord") is False and d.get("action") == "execution:word:issue", lambda d: f"issue word retained={d.get('issueWord')}, next={d.get('action')}")
    check("n381", lambda d: len(d) == 6 and all(row.get("ok") is True for row in d), lambda d: f"wave lines={d}")
    check("n382", lambda d: d.get("handedIn", {}).get("bookAfterSecondPass") == 1 and d.get("handedIn", {}).get("packageIsOfThePieces") is True, lambda d: f"wave book={d.get('handedIn')}")
    check("n1128", lambda d: d.get("stopped") == "paused" and d.get("reloaded") == "paused" and d.get("rows") == 1, lambda d: f"stop={d.get('stopped')}, reload={d.get('reloaded')}, rows={d.get('rows')}")
    check("n1590", lambda d: d.get("content", "").startswith(d.get("original", "missing")) and "Developer preferences" in d.get("content", "") and "npm test" in d.get("content", "") and d.get("unchangedOnRepeat") is True and d.get("writes") == 1 and d.get("expectedSha256") == d.get("originalSha"), lambda d: f"PROJECT.md preserved and preferences appended once: {d}")
    check("n1606", lambda d: d.get("ok") is True, lambda d: f"design gate={d}")
    check("n1607", lambda d: d.get("complete") is None and "accessibility" in d.get("missing", ""), lambda d: f"UI contract sections={d}")
    check("n1624", lambda d: "profile.stack" in d.get("profile", []) and "profile.test_command" in d.get("profile", []) and d.get("row", {}).get("refused") == ["token"], lambda d: f"profile result={d}")
    check("n1684", lambda d: "export const reset = () => true;" in d and "writer's self-report" in d and "trust me" not in d, lambda d: f"blind prompt carries tree bytes and omits writer report={('export const reset = () => true;' in d, 'writer\'s self-report' in d, 'trust me' in d)}")


def scenario_sma_phase_traces(tmp) -> dict:
    proofs = Proofs()
    prove_phase_traces(proofs, tmp)
    return proofs.verdict("sma_phase_traces", checked=len(NODES))
