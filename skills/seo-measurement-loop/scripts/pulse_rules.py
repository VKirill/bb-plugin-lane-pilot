#!/usr/bin/env python3
"""SEO pulse traffic rule with the Council S-05 guards (lag window, Poisson, low volume, RU holidays, demand).

Distilled from the Kotenkov 4.6 «seo-pulse» lesson (pulse_rules.traffic_eval: 7 full days vs the 7
before, percent + noise filter + minimum base) hardened by Council S-05 / D-02:
  * only final days: current window = 7 days inside [as_of-10d, as_of-3d) (GSC/Webmaster lag 48-72h),
    baseline = the 7 days right before it (same weekdays);
  * alert = ratio < 0.82 AND baseline_7d >= 150 AND poisson_z < -2.5 AND no RU holiday in either window;
  * Poisson low-volume guard: baseline < 150 gives status "low_volume", never an alert;
  * demand control: impressions ratio < 0.82 and |delta avg position| < 0.5 means seasonality —
    seo_drop_diagnosis_allowed = false.
poisson_z = (current - baseline) / sqrt(current + baseline)  (two-sample Poisson approximation).

Input JSON: {"as_of": "YYYY-MM-DD", "clicks": {date: n}, "impressions": {date: n},
             "position": {date: avg}, "holidays_extra": ["YYYY-MM-DD"],
             "thresholds": {"ratio": 0.82, "min_base": 150, "z": -2.5, "lag_days": 3, "window_days": 7}}
Output JSON: windows{}, metrics{clicks,impressions}, demand_control{}, verdict, level,
             seo_drop_diagnosis_allowed, reasons[].
"""
import argparse
import json
import math
import sys
from datetime import date, timedelta

NAME = "pulse_rules.py"
VERSION = "1.0.0"
DEFAULTS = {"ratio": 0.82, "min_base": 150, "z": -2.5, "lag_days": 3, "window_days": 7,
            "critical_ratio": 0.65, "pos_stable": 0.5}
# Fixed RU public holidays (Labour Code art.112); New Year holidays Jan 1-8. Transfers come via holidays_extra.
RU_FIXED = [(1, d) for d in range(1, 9)] + [(2, 23), (3, 8), (5, 1), (5, 9), (6, 12), (11, 4)]


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
    as_of = date(2026, 12, 10)
    clicks, impr, pos = {}, {}, {}
    for i in range(40):
        d = as_of - timedelta(days=i)
        weekday = 0.75 if d.weekday() >= 5 else 1.0
        drop = 0.6 if as_of - timedelta(days=10) <= d else 1.0      # ranking drop in the final window
        clicks[d.isoformat()] = round(60 * weekday * drop)
        impr[d.isoformat()] = round(2400 * weekday)
        pos[d.isoformat()] = 4.1 if drop == 1.0 else 6.3
    return {"as_of": as_of.isoformat(), "clicks": clicks, "impressions": impr, "position": pos}


FIXTURE = _fixture()


def iso(d):
    return d.isoformat()


def windows(as_of, lag, width):
    cur_to = as_of - timedelta(days=lag + 1)            # last FINAL day (half-open end as_of - lag)
    cur_from = cur_to - timedelta(days=width - 1)
    base_to = cur_from - timedelta(days=1)
    base_from = base_to - timedelta(days=width - 1)
    return base_from, base_to, cur_from, cur_to


def days(a, b):
    while a <= b:
        yield a
        a += timedelta(days=1)


def window_sum(series, a, b):
    total = 0.0
    for d in days(a, b):
        v = series.get(iso(d))
        if v is None:
            return None
        total += float(v)
    return total


def window_mean(series, a, b):
    vals = [float(series[iso(d)]) for d in days(a, b) if iso(d) in series]
    return sum(vals) / len(vals) if vals else None


def poisson_z(base, cur):
    total = base + cur
    return 0.0 if total <= 0 else round((cur - base) / math.sqrt(total), 3)


def holidays(years, extra):
    out = {date(y, m, d) for y in years for m, d in RU_FIXED}
    return out | {date.fromisoformat(x) for x in extra or []}


def evaluate(series, bf, bt, cf, ct, th):
    base, cur = window_sum(series, bf, bt), window_sum(series, cf, ct)
    if base is None or cur is None:
        return {"status": "incomplete_window", "base": base, "current": cur}
    ratio = round(cur / base, 4) if base else None
    z = poisson_z(base, cur)
    return {"status": "ok", "base": base, "current": cur, "ratio": ratio, "poisson_z": z,
            "low_volume": base < th["min_base"],
            "breach": base >= th["min_base"] and ratio is not None and ratio < th["ratio"] and z < th["z"]}


def compute(data, args):
    th = dict(DEFAULTS, **(data.get("thresholds") or {}))
    as_of = date.fromisoformat(args.as_of or data["as_of"])
    bf, bt, cf, ct = windows(as_of, int(th["lag_days"]), int(th["window_days"]))
    hol = holidays({bf.year, ct.year}, data.get("holidays_extra"))
    hol_hit = sorted(iso(d) for d in days(bf, ct) if d in hol)
    clicks = evaluate(data["clicks"], bf, bt, cf, ct, th)
    impr = evaluate(data.get("impressions") or {}, bf, bt, cf, ct, th)
    pos = data.get("position") or {}
    pb, pc = window_mean(pos, bf, bt), window_mean(pos, cf, ct)
    dpos = round(pc - pb, 3) if pb is not None and pc is not None else None
    seasonal = (impr.get("status") == "ok" and impr["ratio"] is not None and impr["ratio"] < th["ratio"]
                and dpos is not None and abs(dpos) < th["pos_stable"])
    reasons, verdict, level = [], "ok", None
    if clicks["status"] != "ok":
        verdict = "incomplete"
        reasons.append("window has missing days: no comparison")
    elif clicks["low_volume"]:
        verdict = "low_volume"
        reasons.append("baseline %.0f < %d: Poisson noise dominates, no alert" % (clicks["base"], th["min_base"]))
    elif clicks["breach"] and hol_hit:
        verdict = "holiday_suppressed"
        reasons.append("RU holiday in comparison windows: %s" % ", ".join(hol_hit))
    elif clicks["breach"] and seasonal:
        verdict = "seasonality"
        reasons.append("impressions fell with a stable position: demand, not ranking")
    elif clicks["breach"]:
        verdict = "alert"
        level = "critical" if clicks["ratio"] < th["critical_ratio"] else "warning"
        reasons.append("ratio %.3f < %.2f, z %.2f < %.1f, base %.0f" % (clicks["ratio"], th["ratio"],
                                                                        clicks["poisson_z"], th["z"], clicks["base"]))
    return {"as_of": iso(as_of), "thresholds": th,
            "windows": {"base_from": iso(bf), "base_to": iso(bt), "cur_from": iso(cf), "cur_to": iso(ct),
                        "final_range": "[%s, %s)" % (iso(as_of - timedelta(days=10)), iso(as_of - timedelta(days=3)))},
            "metrics": {"clicks": clicks, "impressions": impr,
                        "position": {"base_avg": pb, "cur_avg": pc, "delta": dpos}},
            "holidays_in_window": hol_hit,
            "demand_control": {"seasonality": seasonal, "impressions_ratio": impr.get("ratio"), "delta_avg_pos": dpos},
            "verdict": verdict, "level": level, "reasons": reasons,
            "seo_drop_diagnosis_allowed": verdict == "alert"}


def main():
    ap = Parser(prog=NAME, description="SEO pulse rule: lag-safe 7v7 window with Poisson, holiday and demand guards.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--as-of", help="evaluation date YYYY-MM-DD (default: input as_of)")
    ap.add_argument("--strict", action="store_true", help="exit 3 when verdict is alert")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "alert":
        sys.exit(3)


if __name__ == "__main__":
    main()
