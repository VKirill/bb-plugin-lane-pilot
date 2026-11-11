#!/usr/bin/env python3
"""Drop window split: find when the drop started and build aligned comparison windows with update quarantine.

Distilled from the Kotenkov 4.7 «traffic-drop» lesson (drop_01_window: episodes, «is the drop real»)
and the seo-update-forensics method: compare whole weeks with the same weekdays, never a rollout
period against a clean one, and add a year-over-year pair when history allows.

Steps:
  1. change point: the day t that maximizes the drop between the mean of `seg` days before t and the
     `seg` days from t (seg = 14 by default), with Poisson z = (pre-post)/sqrt(pre+post) on window sums;
  2. windows: post = L days from the drop start (L = whole weeks, up to 28), pre = the L days before,
     yoy = the same windows shifted by 364 days (weekday aligned) when the series covers them;
  3. update quarantine: when a known core/spam update rollout overlaps the post window, the post window
     moves to start the day after the rollout ends (if data allows) and the overlap is reported.

Input JSON: {"series": {date: value}, "field": "clicks", "segment_days": 14, "max_window_days": 28,
             "known_updates": [{"name", "start", "end"}], "min_drop_pct": 15, "z_min": 3.0}
Output JSON: drop{start, pre_mean, post_mean, delta_pct, z, real}, windows{pre, post, yoy_pre, yoy_post},
             quarantine{}, update_overlap[].
"""
import argparse
import json
import math
import sys
from datetime import date, timedelta

NAME = "drop_window_split.py"
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
    start = date(2025, 7, 1)
    series = {}
    for i in range(480):
        d = start + timedelta(days=i)
        wk = 0.72 if d.weekday() >= 5 else 1.0
        lvl = 0.62 if d >= date(2026, 9, 2) else 1.0
        series[d.isoformat()] = round(320 * wk * lvl * (1 + 0.03 * ((i * 7) % 5 - 2)))
    return {"series": series, "field": "clicks",
            "known_updates": [{"name": "August 2026 core update", "start": "2026-08-27", "end": "2026-09-10"}]}


FIXTURE = _fixture()


def d_(s):
    return date.fromisoformat(s)


def span(a, b):
    return {"from": a.isoformat(), "to": b.isoformat(), "days": (b - a).days + 1}


def total(series, a, b):
    vals, d = [], a
    while d <= b:
        v = series.get(d)
        if v is None:
            return None
        vals.append(v)
        d += timedelta(days=1)
    return sum(vals)


def compute(data, args):
    series = {d_(k): float(v) for k, v in data["series"].items()}
    if len(series) < 42:
        raise ValueError("need at least 42 days of daily data")
    first, last = min(series), max(series)
    seg = int(data.get("segment_days", 14))
    max_w = int(data.get("max_window_days", 28))
    z_min, min_pct = float(data.get("z_min", 3.0)), float(data.get("min_drop_pct", 15))
    best = None
    t = first + timedelta(days=seg)
    while t + timedelta(days=seg - 1) <= last:
        pre = total(series, t - timedelta(days=seg), t - timedelta(days=1))
        post = total(series, t, t + timedelta(days=seg - 1))
        if pre and post is not None:
            drop = (pre - post) / pre
            if best is None or drop > best[0] + 1e-12:
                best = (drop, t, pre, post)
        t += timedelta(days=1)
    if best is None:
        raise ValueError("series has gaps everywhere: no complete segments")
    drop, start, pre_s, post_s = best
    z = round((pre_s - post_s) / math.sqrt(pre_s + post_s), 2) if pre_s + post_s > 0 else 0.0
    real = drop * 100 >= min_pct and z >= z_min
    updates = []
    for u in data.get("known_updates") or []:
        updates.append({"name": u["name"], "start": d_(u["start"]), "end": d_(u.get("end") or u["start"])})
    avail_after = (last - start).days + 1
    L = min(max_w, 7 * (avail_after // 7))
    if L < 7:
        raise ValueError("less than one full week after the drop start")
    post_from = start
    overlap = [u for u in updates if u["start"] <= start + timedelta(days=L - 1) and u["end"] >= start - timedelta(days=L)]
    quarantine = {"applied": False}
    for u in overlap:
        if u["start"] <= post_from <= u["end"] or post_from <= u["start"] <= post_from + timedelta(days=L - 1):
            cand = u["end"] + timedelta(days=1)
            room = (last - cand).days + 1
            if room >= 7:
                post_from = cand
                L = min(L, 7 * (room // 7))
                quarantine = {"applied": True, "excluded": span(u["start"], u["end"]), "update": u["name"],
                              "reason": "post window starts after the rollout ends"}
            else:
                quarantine = {"applied": False, "update": u["name"],
                              "reason": "rollout not finished long enough ago: verdict must wait"}
    post_to = post_from + timedelta(days=L - 1)
    pre_to = start - timedelta(days=1)
    pre_from = pre_to - timedelta(days=L - 1)
    if quarantine.get("applied"):
        ex = quarantine["excluded"]
        if d_(ex["from"]) <= pre_to:
            pre_to = d_(ex["from"]) - timedelta(days=1)
            pre_from = pre_to - timedelta(days=L - 1)
    windows = {"pre": span(pre_from, pre_to), "post": span(post_from, post_to)}
    yoy = {}
    if pre_from - timedelta(days=364) >= first:
        windows["yoy_pre"] = span(pre_from - timedelta(days=364), pre_to - timedelta(days=364))
        windows["yoy_post"] = span(post_from - timedelta(days=364), post_to - timedelta(days=364))
        ya = total(series, pre_from - timedelta(days=364), pre_to - timedelta(days=364))
        yb = total(series, post_from - timedelta(days=364), post_to - timedelta(days=364))
        if ya and yb is not None:
            yoy = {"last_year_delta_pct": round((yb - ya) / ya * 100, 2),
                   "note": "a similar last-year change at the same dates points to seasonality"}
    pre_w, post_w = total(series, pre_from, pre_to), total(series, post_from, post_to)
    return {"field": data.get("field", "clicks"),
            "drop": {"start": start.isoformat(), "segment_days": seg, "pre_mean": round(pre_s / seg, 2),
                     "post_mean": round(post_s / seg, 2), "delta_pct": round(-drop * 100, 2), "z": z, "real": real},
            "windows": windows,
            "window_delta_pct": round((post_w - pre_w) / pre_w * 100, 2) if pre_w and post_w is not None else None,
            "yoy": yoy, "quarantine": quarantine,
            "update_overlap": [{"name": u["name"], "start": u["start"].isoformat(), "end": u["end"].isoformat()}
                               for u in overlap]}


def main():
    ap = Parser(prog=NAME, description="Find the drop start and build weekday-aligned pre/post/YoY windows.")
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
