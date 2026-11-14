"""Region 28 · Design training and evaluation: a region scene (docs/sma-evidence.md, «Trace choice»).

These nodes measure design work: scores, ratios, verdicts. The journal lives in plugin KV and the scores write no hub row, so each node is proved
here: the probe (sma_r28_probe.ts) runs the REAL design-eval code of the commit under drill on fixture measurements, journal lines and critique
forms (no model, no hub write), and the scene compares every number with the one worked out by hand from the card. Run: scripts/lp-drill.sh --scenario sma_r28
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n1756", "n1757", "n1758", "n1759", "n1760", "n1761", "n1762", "n1763", "n1764", "n1765", "n1766", "n1767"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r28_probe.ts"


def scenario_sma_r28(tmp) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=240)
    try:
        seen = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r28", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])

    # n1756 The score is the mean of every criterion at every width: (1.5 + 2.5) / 12 = 33; clean 100; a clean phone with a flawed desktop (6 + 2.5) / 12 = 71.
    ok = seen["badScore"] == 33 and seen["cleanScore"] == 100 and seen["mixedScore"] == 71 and seen["badPhone"] == [0, 0.5, 0, 0.5, 0, 0.5]
    proofs.prove("n1756", ok, f"flawed {seen['badScore']}, clean {seen['cleanScore']}, mixed {seen['mixedScore']}, flawed phone criteria {seen['badPhone']}")
    # n1757 A written case reads back; a changed measurement under the pinned hash is refused as differing bytes.
    proofs.prove("n1757", seen["caseRead"] is True and seen["caseBytes"] == "design_case_bytes_differ", f"read back {seen['caseRead']}, changed bytes {seen['caseBytes']}")
    # n1758 Five fixture drawings: first pass 3/5, judge agrees 2 of the 3 judged (not of 5), coverage (1 + .5 + 1)/3, code score (100+80+100)/3.
    r = seen["ratios"]
    ok = r == {"drawings": 5, "firstPass": 0.6, "passedAll": 0.67, "critiquePass": 0.67, "judgeAgrees": 0.67, "pointCoverage": 0.83, "codeScore": 93, "ownerYes": 0.5}
    proofs.prove("n1758", ok, f"ratios {r}")
    # n1759 Six obligations, each worth one unit: failing any one costs 1/6 (83).
    proofs.prove("n1759", seen["rubric"] == ["overflow", "contrast", "targets", "tiny_text", "one_h1", "spacing"] and seen["oneFailure"] == [83, 83, 83], f"rubric {seen['rubric']}, one failure scores {seen['oneFailure']}")
    # n1760 A repeated packet is one fact; another drawing and then the first again is a new one.
    proofs.prove("n1760", seen["afterRepeat"] == 1 and seen["shas"] == ["sha1", "sha2", "sha1"], f"after a repeat {seen['afterRepeat']} line, then drawings {seen['shas']}")
    # n1761 A score of 4 is refused by name.
    proofs.prove("n1761", seen["critiqueScore4"] == ["brand: a score is 0–3 on a known axis"], f"score 4 -> {seen['critiqueScore4']}")
    # n1762 The page shown first (here B, order ba) is listed as «first» with its own 33/100; the pair's winner is the clean design A (100 against 33).
    ok = seen["pairOrder"] == "ba" and seen["pairFirst"] == "first: 33/100; 3" and seen["pairWinner"] == "a" and seen["pairScores"] == [100, 33]
    proofs.prove("n1762", ok, f"order {seen['pairOrder']}, first line starts {seen['pairFirst']!r}, winner {seen['pairWinner']} {seen['pairScores']}")
    # n1763 The motion row is found in English and in Russian; a word that only contains «motion» is not.
    proofs.prove("n1763", seen["motion"] == ["hud", "ru"], f"motion rows {seen['motion']}")
    # n1764 Trained says so; otherwise the sentence names what is open.
    ok = seen["readyTrained"] == "Дизайнер обучен:" and seen["readyOpen"] == "Дизайнер ещё учится: 3 of 8 drawings. Чертежи идут через ревью отдельной роли."
    proofs.prove("n1764", ok, f"{seen['readyTrained']!r} / {seen['readyOpen']!r}")
    # n1765 A lesson becomes one dated line, whitespace collapsed, at most 200 characters after the date.
    proofs.prove("n1765", seen["roleLine"] == "2026-11-10 leave air around the hero" and seen["roleLineCap"] == 211, f"{seen['roleLine']!r}, a 300-character lesson gives {seen['roleLineCap']} characters")
    # n1766 Exactly at the thresholds (7 of 10 first pass, 8 of 10 critiques pass) all four conditions are closed; 6 of 10 opens the first-pass one only.
    proofs.prove("n1766", seen["conditionsEdge"] == [True, True, True, True] and seen["conditionsBelow"] == [True, False, True, True], f"at the thresholds {seen['conditionsEdge']}, first pass 0.6 {seen['conditionsBelow']}")
    # n1767 A drawing before any role line is «base»; one after it carries the hash of that line, and a drawing is stamped with it.
    proofs.prove("n1767", seen["series"][0] == "base" and seen["seriesAfterRoleLine"] is True, f"series {seen['series']}")
    return proofs.verdict("sma_r28", checked=len(NODES))
