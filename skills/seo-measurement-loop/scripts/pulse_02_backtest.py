#!/usr/bin/env python3
"""SEO pulse backtest (GATE 2): what the monitor would have said over past months, per threshold profile.

Distilled from the Kotenkov 4.6 lesson (pulse_02_backtest): replay THE SAME rule as the daily run over
every historic day (7 full days vs the 7 before, percent + Poisson noise filter + minimum base) and
count alert EPISODES — consecutive breach days (with recover-1 quiet days tolerated) are one message.
Then pick the most sensitive profile that stays within the alert budget and still catches the known
incidents. The Poisson guard is the Council S-05 one: z = (cur - base)/sqrt(cur + base).

Input JSON: {"series": {date: value}, "from": "YYYY-MM-DD", "to": "YYYY-MM-DD",
             "known_incidents": ["YYYY-MM-DD"], "max_alerts_per_30d": 2, "recover_days": 2,
             "profiles": {name: {"warning_pct", "critical_pct", "z_min", "min_base"}}}
Output JSON: profiles{name: {episodes[], episodes_per_30d, evaluated_days, small_days, caught}},
             recommended, reason.
"""
import argparse
import json
import math
import sys
from datetime import date, timedelta

NAME = "pulse_02_backtest.py"
VERSION = "1.0.0"
PROFILES = {
    "default":   {"warning_pct": -20.0, "critical_pct": -35.0, "z_min": 3.0, "min_base": 50},
    "sensitive": {"warning_pct": -15.0, "critical_pct": -30.0, "z_min": 2.0, "min_base": 30},
    "coarse":    {"warning_pct": -30.0, "critical_pct": -45.0, "z_min": 4.0, "min_base": 100},
    "naive":     {"warning_pct": -20.0, "critical_pct": -35.0, "z_min": 0.0, "min_base": 0},
}
PREFERENCE = ("sensitive", "default", "coarse")     # most sensitive first; "naive" is a reference only


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
    start = date(2026, 6, 1)
    series = {}
    for i in range(150):
        d = start + timedelta(days=i)
        wk = 0.7 if d.weekday() >= 5 else 1.0
        wobble = (1.0, 1.08, 0.94, 1.03, 0.97, 1.05, 0.92)[i % 7]
        level = 0.55 if date(2026, 8, 21) <= d <= date(2026, 9, 10) else 1.0
        series[d.isoformat()] = round(40 * wk * wobble * level)
    return {"series": series, "from": "2026-06-20", "to": "2026-10-28", "known_incidents": ["2026-08-21"],
            "max_alerts_per_30d": 2}


FIXTURE = _fixture()


def z_drop(base, fact):
    total = base + fact
    return 0.0 if total <= 0 else round((base - fact) / math.sqrt(total), 2)


def window_sum(series, a, b):
    total, d = 0.0, a
    while d <= b:
        v = series.get(d.isoformat())
        if v is None:
            return None
        total += float(v)
        d += timedelta(days=1)
    return total


def traffic_eval(series, complete_to, th):
    cf = complete_to - timedelta(days=6)
    bt = cf - timedelta(days=1)
    bf = bt - timedelta(days=6)
    base, fact = window_sum(series, bf, bt), window_sum(series, cf, complete_to)
    if base is None or fact is None:
        return None
    delta = round((fact - base) / base * 100, 1) if base else None
    z = z_drop(base, fact)
    small = base < th["min_base"]
    breach = (not small) and delta is not None and delta <= th["warning_pct"] and z >= th["z_min"]
    level = ("critical" if delta <= th["critical_pct"] else "warning") if breach else None
    return {"base": base, "fact": fact, "delta_pct": delta, "z": z, "small": small, "breach": breach, "level": level}


def replay(series, start, end, th, recover):
    episodes, cur, quiet, evaluated, small = [], None, 0, 0, 0
    d = start
    while d <= end:
        ev = traffic_eval(series, d, th)
        if ev is not None:
            evaluated += 1
            small += 1 if ev["small"] else 0
            if ev["breach"]:
                if cur is None:
                    cur = {"start": d.isoformat(), "end": d.isoformat(), "days": 0, "worst_pct": ev["delta_pct"],
                           "level": ev["level"]}
                cur["end"], cur["days"], quiet = d.isoformat(), cur["days"] + 1, 0
                if ev["delta_pct"] < cur["worst_pct"]:
                    cur["worst_pct"] = ev["delta_pct"]
                if ev["level"] == "critical":
                    cur["level"] = "critical"
            elif cur is not None:
                quiet += 1
                if quiet >= recover:
                    episodes.append(cur)
                    cur, quiet = None, 0
        d += timedelta(days=1)
    if cur is not None:
        episodes.append(cur)
    return episodes, evaluated, small


def caught(episodes, incident):
    inc = date.fromisoformat(incident)
    return any(inc - timedelta(days=1) <= date.fromisoformat(e["start"]) <= inc + timedelta(days=10) for e in episodes)


def compute(data, args):
    series = {k: float(v) for k, v in data["series"].items()}
    if len(series) < 21:
        raise ValueError("need at least 21 days of history")
    keys = sorted(series)
    start = date.fromisoformat(data.get("from") or keys[13])
    end = date.fromisoformat(data.get("to") or keys[-1])
    profiles = dict(PROFILES, **(data.get("profiles") or {}))
    budget = float(data.get("max_alerts_per_30d", 2))
    recover = int(data.get("recover_days", 2))
    incidents = list(data.get("known_incidents") or [])
    span = max(1, (end - start).days + 1)
    out = {}
    for name, th in sorted(profiles.items()):
        eps, evaluated, small = replay(series, start, end, th, recover)
        out[name] = {"thresholds": th, "episodes": eps, "episode_count": len(eps),
                     "episodes_per_30d": round(len(eps) * 30 / span, 3), "evaluated_days": evaluated,
                     "small_days": small, "caught": {i: caught(eps, i) for i in incidents},
                     "caught_all": all(caught(eps, i) for i in incidents)}
    order = [p for p in PREFERENCE if p in out] + sorted(p for p in out if p not in PREFERENCE and p != "naive")
    within = [p for p in order if out[p]["episodes_per_30d"] <= budget]
    full = [p for p in within if out[p]["caught_all"]]
    if full:
        rec, why = full[0], "most sensitive profile within %.1f alerts/30d that catches every known incident" % budget
    elif within:
        rec, why = max(within, key=lambda p: (sum(out[p]["caught"].values()), -order.index(p))), \
            "no profile catches every incident within budget: best coverage inside budget"
    else:
        rec, why = "coarse" if "coarse" in out else order[-1], "every profile exceeds the alert budget: coarsest"
    return {"from": start.isoformat(), "to": end.isoformat(), "days": span, "alert_budget_per_30d": budget,
            "profiles": out, "recommended": rec, "reason": why}


def main():
    ap = Parser(prog=NAME, description="Backtest pulse thresholds on own history and recommend a profile.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
