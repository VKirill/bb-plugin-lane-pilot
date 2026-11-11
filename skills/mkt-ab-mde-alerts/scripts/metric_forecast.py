#!/usr/bin/env python3
"""Metric forecast corridor: additive Holt-Winters with a grid-searched fit and prediction intervals (Council D-08).

Distilled from the Karpov «Forecasting metrics» lesson (Orbit DLT with seasonality, bootstrap
intervals, backtest) as a dependency-free model: additive level + trend + seasonality, parameters
picked by one-step-ahead SSE on a grid, interval half-width = z * sigma * sqrt(1 + (h-1) * alpha^2)
(sigma = RMSE of one-step errors). Decisions use the corridor, never a point forecast; actuals
outside the corridor are flagged.

Input JSON: {"values": [..] | "series": {date: v}, "season": 7, "horizon": 14, "level": 0.95,
             "actuals": [..] (optional, compared to the first len(actuals) forecast steps)}
Output JSON: params{alpha, beta, gamma}, rmse, forecast[] {h, yhat, lo, hi}, backtest{mape}, checks[].
"""
import argparse
import json
import math
import sys

NAME = "metric_forecast.py"
VERSION = "1.0.0"
GRID_A = (0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9)
GRID_B = (0.0, 0.01, 0.05, 0.1, 0.2)
GRID_G = (0.05, 0.1, 0.2, 0.3, 0.5)


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
    season = (1.0, 1.04, 1.02, 0.99, 0.95, 0.78, 0.74)
    noise = (0.01, -0.02, 0.015, -0.005, 0.02, -0.01, 0.0, 0.012, -0.018)
    vals = [round((1000 + 3 * i) * season[i % 7] * (1 + noise[i % 9]), 2) for i in range(84)]
    actual = [round((1000 + 3 * i) * season[i % 7], 2) for i in range(84, 91)]
    actual[5] = round(actual[5] * 0.7, 2)          # a real dip on day 6 of the horizon
    return {"values": vals, "season": 7, "horizon": 14, "level": 0.95, "actuals": actual}


FIXTURE = _fixture()


def norm_ppf(p):
    lo, hi = -12.0, 12.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if 0.5 * math.erfc(-mid / math.sqrt(2)) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def fit(y, m, a, b, g):
    level = sum(y[:m]) / m
    trend = (sum(y[m:2 * m]) - sum(y[:m])) / (m * m)
    seas = [y[i] - level for i in range(m)]
    sse, errs = 0.0, []
    for t in range(m, len(y)):
        pred = level + trend + seas[t % m]
        e = y[t] - pred
        errs.append((y[t], pred))
        sse += e * e
        last_level = level
        level = a * (y[t] - seas[t % m]) + (1 - a) * (level + trend)
        trend = b * (level - last_level) + (1 - b) * trend
        seas[t % m] = g * (y[t] - level) + (1 - g) * seas[t % m]
    return sse, level, trend, seas, errs


def compute(data, args):
    if data.get("values") is not None:
        y = [float(v) for v in data["values"]]
    else:
        y = [float(data["series"][k]) for k in sorted(data["series"])]
    m = int(data.get("season", 7))
    h = int(args.horizon or data.get("horizon", 14))
    lvl = float(data.get("level", 0.95))
    if m < 1 or len(y) < 2 * m + 2:
        raise ValueError("need at least 2 full seasons + 2 points (got %d, season %d)" % (len(y), m))
    best = None
    for a in GRID_A:
        for b in GRID_B:
            for g in GRID_G:
                res = fit(y, m, a, b, g)
                if best is None or res[0] < best[0][0] - 1e-9:
                    best = (res, (a, b, g))
    (sse, level, trend, seas, errs), (a, b, g) = best
    n_err = len(y) - m
    rmse = math.sqrt(sse / n_err)
    z = norm_ppf(0.5 + lvl / 2)
    fc = []
    for k in range(1, h + 1):
        yhat = level + k * trend + seas[(len(y) + k - 1) % m]
        half = z * rmse * math.sqrt(1 + (k - 1) * a * a)
        fc.append({"h": k, "yhat": round(yhat, 4), "lo": round(yhat - half, 4), "hi": round(yhat + half, 4)})
    tail = errs[-2 * m:]
    mape = sum(abs(t - p) / abs(t) for t, p in tail if t) / max(1, sum(1 for t, _ in tail if t))
    checks = []
    for k, act in enumerate(data.get("actuals") or [], start=1):
        if k > h:
            break
        f = fc[k - 1]
        status = "below" if act < f["lo"] else ("above" if act > f["hi"] else "inside")
        checks.append({"h": k, "actual": act, "lo": f["lo"], "hi": f["hi"], "status": status})
    return {"params": {"alpha": a, "beta": b, "gamma": g, "season": m}, "rmse": round(rmse, 4), "level": lvl,
            "n": len(y), "forecast": fc, "backtest": {"mape_last_2_seasons": round(mape, 4)},
            "checks": checks, "outside_corridor": sum(1 for c in checks if c["status"] != "inside")}


def main():
    ap = Parser(prog=NAME, description="Holt-Winters corridor forecast with prediction intervals.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--horizon", type=int, help="forecast steps (default: input horizon or 14)")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
