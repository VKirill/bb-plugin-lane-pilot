#!/usr/bin/env python3
"""Product alerts: robust MAD z-score per metric x slice, Benjamini-Hochberg FDR per tick, 2-window hysteresis.

Distilled from the Karpov «15 product alerts» lesson (metric x slice grid, compare with day-1 and
day-7, Telegram alert) and hardened by Council D-02: 50 checks a day at p < 0.05 give ~2.5 false
alarms daily, so
  * robust z = (x - median) / (1.4826 * MAD) on the SAME slot of the last `weeks` periods
    (same weekday for daily data, same hour-of-week for hourly — `period` points back);
  * p = two-sided normal p-value of z; Benjamini-Hochberg at q = 0.10 over ALL tests of the tick;
  * alert only when |z| >= 3.5, BH rejects, and the previous window also had |z| >= 3.5 (hysteresis).
The legacy Karpov rule (|x/day1-1| and |x/day7-1| >= threshold) is reported for comparison only.

Input JSON: {"period": 7, "weeks": 8, "z_threshold": 3.5, "fdr_q": 0.10, "consecutive": 2,
             "legacy_threshold": 0.3, "series": {"metric|slice": [v0, v1, ..., v_now]}}
Output JSON: tests[] {key, value, median, mad, z, p, q_value, bh_reject, prev_z, alert, direction,
             legacy_alert}, alerts[], summary{}.
"""
import argparse
import json
import math
import sys

NAME = "product_alerts.py"
VERSION = "1.0.0"


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


def _fixture():
    wob = (1.0, 1.03, 0.97, 1.02, 0.98, 1.01, 0.99, 1.04, 0.96)
    def daily(base, last=None, prev=None, n=64):
        s = [round(base * (0.8 if i % 7 in (5, 6) else 1.0) * wob[i % 9], 6) for i in range(n)]
        if prev is not None:
            s[-2] = prev
        if last is not None:
            s[-1] = last
        return s
    return {"period": 7, "series": {
        "dau|all": daily(10000, last=6100, prev=6400),          # sustained drop: alert
        "dau|ios": daily(4000, last=2600),                       # one-window spike: no hysteresis
        "ctr|all": daily(0.032),                                 # normal
        "likes|android": daily(52000, last=51000),               # normal
        "views|web": daily(120000, last=180000, prev=176000),    # sustained rise: alert
    }}


FIXTURE = _fixture()


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def robust_z(series, idx, period, weeks):
    hist = [series[idx - period * k] for k in range(1, weeks + 1) if idx - period * k >= 0]
    if len(hist) < max(4, weeks // 2):
        return None
    med = median(hist)
    mad = median([abs(h - med) for h in hist])
    scale = 1.4826 * mad
    if scale == 0:
        mean_ad = sum(abs(h - med) for h in hist) / len(hist)
        scale = 1.253314 * mean_ad
    x = series[idx]
    if scale == 0:
        z = 0.0 if x == med else math.copysign(1e6, x - med)
    else:
        z = (x - med) / scale
    return {"value": x, "median": med, "mad": mad, "z": z, "history": len(hist)}


def p_two_sided(z):
    return math.erfc(abs(z) / math.sqrt(2))


def bh(pvals, q):
    """Benjamini-Hochberg: returns (q_values, reject flags) in input order."""
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    qv, prev = [0.0] * m, 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        prev = min(prev, pvals[i] * m / rank)
        qv[i] = prev
    return qv, [qv[i] <= q for i in range(m)]


def legacy(series, idx, thr):
    x, d1, d7 = series[idx], series[idx - 1] if idx >= 1 else None, series[idx - 7] if idx >= 7 else None
    if not d1 or not d7 or not x:
        return False
    diff = lambda a, b: abs(a / b - 1) if a <= b else abs(b / a - 1)
    between = d1 <= x <= d7 or d7 <= x <= d1
    return (not between) and diff(x, d1) >= thr and diff(x, d7) >= thr


def compute(data, args):
    period, weeks = int(data.get("period", 7)), int(data.get("weeks", 8))
    zt, q = float(data.get("z_threshold", 3.5)), float(data.get("fdr_q", 0.10))
    need = int(data.get("consecutive", 2))
    thr = float(data.get("legacy_threshold", 0.3))
    series = data["series"]
    if not series:
        raise ValueError("series is empty")
    rows, skipped = [], []
    for key in sorted(series):
        s = series[key]
        if isinstance(s, dict):
            s = [s[k] for k in sorted(s)]
        s = [float(v) for v in s]
        now = robust_z(s, len(s) - 1, period, weeks)
        if now is None:
            skipped.append({"key": key, "reason": "history shorter than %d periods" % max(4, weeks // 2)})
            continue
        prevs = [robust_z(s, len(s) - 1 - k, period, weeks) for k in range(1, need)]
        rows.append({"key": key, **{k: now[k] for k in ("value", "median", "mad", "history")}, "z": now["z"],
                     "prev_z": [None if p is None else round(p["z"], 3) for p in prevs],
                     "legacy_alert": legacy(s, len(s) - 1, thr)})
    if not rows:
        raise ValueError("no series with enough history")
    pv = [p_two_sided(r["z"]) for r in rows]
    qv, rej = bh(pv, q)
    alerts = []
    for r, p, qq, ok in zip(rows, pv, qv, rej):
        hyst = all(z is not None and abs(z) >= zt for z in r["prev_z"])
        r.update({"z": round(r["z"], 3), "p": p, "q_value": qq, "bh_reject": ok,
                  "direction": "up" if r["z"] > 0 else "down",
                  "alert": abs(r["z"]) >= zt and ok and hyst})
        if r["alert"]:
            alerts.append({"key": r["key"], "z": r["z"], "direction": r["direction"], "value": r["value"],
                           "median": r["median"], "q_value": qq})
    return {"tests": rows, "alerts": alerts, "skipped": skipped,
            "summary": {"tests": len(rows), "bh_rejections": sum(rej), "alerts": len(alerts),
                        "legacy_alerts": sum(1 for r in rows if r["legacy_alert"]),
                        "params": {"period": period, "weeks": weeks, "z_threshold": zt, "fdr_q": q, "consecutive": need}}}


def main():
    ap = Parser(prog=NAME, description="Robust MAD z-score alerts with Benjamini-Hochberg FDR and hysteresis.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--strict", action="store_true", help="exit 3 when any alert fires")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["alerts"]:
        sys.exit(3)


if __name__ == "__main__":
    main()
