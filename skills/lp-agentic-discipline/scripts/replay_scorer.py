#!/usr/bin/env python3
"""Replay scorer: score recorded agent runs against the agentic-discipline rubric and the expected decision.

Distilled from the Peshkov «Agentic Discipline» canon and Lane Pilot specialist rules, used by
lp.specialist-eval to replay past ticks. Checks per run (weights configurable):
  missing_data_block  the answer has a «Чего не хватило в данных» / «What was missing» block   0.20
  self_doubt          fields.self_doubt is a number in [0, 1]                               0.15
  numbers_sourced     share of numbers in the answer that sit next to a source marker
                      ([src:..], [1], (источник: ..), (source: ..)) or are listed in claims    0.25
  reviewer_ceiling    reviewer_visits < 2                                                    0.10
  cursor_reading      every file read is bounded (limit <= 400 lines or an offset/limit pair)  0.10
  decision_match      decision == expected_decision (replay against the known outcome)       0.20
A run passes with score >= pass_score (0.8) AND decision_match.

Input JSON: {"pass_score": 0.8, "weights": {..}, "runs": [{"run_id", "answer", "fields": {"self_doubt"},
             "reviewer_visits", "reads": [{"path", "offset", "limit"}], "claims": [{"value", "source"}],
             "decision", "expected_decision"}]}
Output JSON: runs[] {run_id, score, pass, checks{}}, aggregate{mean_score, pass_rate, decision_accuracy}, verdict.
"""
import argparse
import json
import re
import sys

NAME = "replay_scorer.py"
VERSION = "1.0.0"
WEIGHTS = {"missing_data_block": 0.20, "self_doubt": 0.15, "numbers_sourced": 0.25, "reviewer_ceiling": 0.10,
           "cursor_reading": 0.10, "decision_match": 0.20}
MISSING_RE = re.compile(r"(?im)^\s*(#+\s*|\*\*)?\s*(чего не хватило в данных|what was missing|missing data)")
NUM_RE = re.compile(r"(?<![\w.])\d[\d\s]*(?:[.,]\d+)?\s*(?:%|₽|руб|k|к)?")
SRC_RE = re.compile(r"\[(?:src:[^\]]+|\d+)\]|\((?:источник|source)\s*:[^)]+\)")


class Parser(argparse.ArgumentParser):
    def error(self, message):
        fail("usage", message, 2)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def fail(code, message, rc=1):
    emit({"ok": False, "script": NAME, "version": VERSION, "error": {"code": code, "message": str(message)}})
    sys.exit(rc)


def load_input(args, fixture):
    if args.fixture:
        return fixture
    if not args.input:
        fail("no_input", "pass --input FILE.json (or - for stdin) or --fixture", 2)
    try:
        if args.input == "-":
            return json.load(sys.stdin)
        with open(args.input, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        fail("bad_input", "%s: %s" % (args.input, exc), 2)


FIXTURE = {"pass_score": 0.8, "runs": [
    {"run_id": "tick-0412", "decision": "hold", "expected_decision": "hold", "reviewer_visits": 1,
     "fields": {"self_doubt": 0.35}, "reads": [{"path": "metrics.csv", "offset": 0, "limit": 200}],
     "answer": "Клики упали на 18% [src:gsc 2026-11-03..09], база 1 240 [src:gsc]. Решение: держать.\n"
               "## Чего не хватило в данных\n- нет данных Вебмастера за 2 последних дня"},
    {"run_id": "tick-0413", "decision": "stop_campaign", "expected_decision": "hold", "reviewer_visits": 3,
     "fields": {}, "reads": [{"path": "crm_export.csv"}],
     "answer": "CAC вырос до 4 200 руб, ROMI -35%, останавливаем кампанию."},
]}


def numbers_sourced(answer, claims):
    claimed = {re.sub(r"\D", "", str(c.get("value"))) for c in claims or [] if c.get("source")}
    total = ok = 0
    head = MISSING_RE.split(answer or "", maxsplit=1)[0]      # the «what was missing» block needs no sources
    for sentence in re.split(r"(?<=[.!?])\s+|\n", head):
        has_src = bool(SRC_RE.search(sentence))
        nums = [n for n in NUM_RE.findall(SRC_RE.sub(" ", sentence)) if re.search(r"\d", n)]
        if not nums:
            continue
        for n in nums:
            total += 1
            if has_src or re.sub(r"\D", "", n) in claimed:
                ok += 1
    return (ok / total if total else 1.0), total, ok


def score_run(r, w, pass_score):
    answer = r.get("answer") or ""
    sd = (r.get("fields") or {}).get("self_doubt")
    share, total, ok = numbers_sourced(answer, r.get("claims"))
    reads = r.get("reads") or []
    bounded = all((rd.get("limit") is not None and int(rd["limit"]) <= 400) or
                  (rd.get("offset") is not None and rd.get("limit") is not None) for rd in reads)
    checks = {
        "missing_data_block": bool(MISSING_RE.search(answer)),
        "self_doubt": isinstance(sd, (int, float)) and not isinstance(sd, bool) and 0 <= sd <= 1,
        "numbers_sourced": round(share, 4),
        "reviewer_ceiling": int(r.get("reviewer_visits") or 0) < 2,
        "cursor_reading": bounded,
        "decision_match": r.get("expected_decision") is None or r.get("decision") == r.get("expected_decision"),
    }
    score = sum(w[k] * (float(v) if not isinstance(v, bool) else (1.0 if v else 0.0)) for k, v in checks.items())
    passed = score >= pass_score and checks["decision_match"]
    return {"run_id": r.get("run_id"), "score": round(score, 4), "pass": passed, "checks": checks,
            "numbers": {"total": total, "sourced": ok},
            "failed_checks": sorted(k for k, v in checks.items() if v is False or (k == "numbers_sourced" and v < 1))}


def compute(data, args):
    w = dict(WEIGHTS, **(data.get("weights") or {}))
    tot = sum(w.values())
    if tot <= 0:
        raise ValueError("weights must sum to a positive number")
    w = {k: v / tot for k, v in w.items()}
    pass_score = float(data.get("pass_score", 0.8))
    runs = data["runs"]
    if not runs:
        raise ValueError("runs is empty")
    out = [score_run(r, w, pass_score) for r in runs]
    with_exp = [r for r, o in zip(runs, out) if r.get("expected_decision") is not None]
    acc = (sum(1 for r in with_exp if r.get("decision") == r.get("expected_decision")) / len(with_exp)) if with_exp else None
    agg = {"runs": len(out), "mean_score": round(sum(o["score"] for o in out) / len(out), 4),
           "pass_rate": round(sum(1 for o in out if o["pass"]) / len(out), 4),
           "decision_accuracy": None if acc is None else round(acc, 4)}
    return {"runs": out, "aggregate": agg, "weights": {k: round(v, 4) for k, v in w.items()}, "pass_score": pass_score,
            "verdict": "pass" if all(o["pass"] for o in out) else "fail"}


def main():
    ap = Parser(prog=NAME, description="Score recorded agent runs against the agentic-discipline rubric.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--strict", action="store_true", help="exit 3 when any run fails")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "fail":
        sys.exit(3)


if __name__ == "__main__":
    main()
