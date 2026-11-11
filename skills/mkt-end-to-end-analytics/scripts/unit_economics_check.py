#!/usr/bin/env python3
"""Unit economics check per channel x cohort with the Council S-04 immature-cohort lag mask.

Distilled from the Osipenkov end-to-end analytics course (lesson 4: CPL, CPO, CAC, AOV, margin,
LTV, DRR, ROMI, fixed vs variable costs) and Council S-04: marginal CAC on fresh spend with a D14
payback undercounts conversions 3-5x and kills profitable campaigns. So:
  * maturity_window_days = P90 of click->payment lag (from lag_samples_days unless given);
  * CDF_pay(k) = share of lag samples <= k for a cohort aged k days; orders_adjusted = orders / CDF(k);
  * a "stop/reduce" decision on a cohort with CDF(k) < 0.6 is forbidden: reason_code immature_cohort,
    only the leading proxy (cost per activated trial) may be used;
  * channel decisions aggregate mature cohorts only; marginal CAC uses adjusted orders.

Input JSON: {"as_of": "YYYY-MM-DD", "maturity_window_days": null, "lag_samples_days": [..],
             "min_cdf_for_stop": 0.6, "target_romi": 0.0, "purchases_per_customer": 1.0,
             "cohorts": [{"channel", "cohort_date", "spend", "leads", "orders", "revenue",
                          "cogs" | "margin_rate", "trials_activated"}]}
Output JSON: maturity_window_days, cohorts[] {metrics, age_days, cdf, mature, decision, reason_code},
             channels{name: {mature_cohorts, cac, romi, marginal_cac, decision}}.
"""
import argparse
import json
import math
import sys
from datetime import date

NAME = "unit_economics_check.py"
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


FIXTURE = {
    "as_of": "2026-11-11", "min_cdf_for_stop": 0.6, "target_romi": 0.0, "purchases_per_customer": 1.6,
    "lag_samples_days": [0, 1, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 18, 21, 24, 28, 30, 35, 40, 45, 52],
    "cohorts": [
        {"channel": "yandex_direct", "cohort_date": "2026-09-01", "spend": 300000, "leads": 600, "orders": 120,
         "revenue": 960000, "margin_rate": 0.45, "trials_activated": 210},
        {"channel": "yandex_direct", "cohort_date": "2026-10-01", "spend": 420000, "leads": 780, "orders": 140,
         "revenue": 1120000, "margin_rate": 0.45, "trials_activated": 260},
        {"channel": "yandex_direct", "cohort_date": "2026-11-04", "spend": 150000, "leads": 260, "orders": 12,
         "revenue": 96000, "margin_rate": 0.45, "trials_activated": 95},
        {"channel": "tg_ads", "cohort_date": "2026-09-01", "spend": 200000, "leads": 300, "orders": 30,
         "revenue": 240000, "cogs": 150000, "trials_activated": 80},
    ],
}


def percentile(xs, q):
    s = sorted(xs)
    if not s:
        return None
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def div(a, b):
    return round(a / b, 4) if b else None


def metrics(c, ppc):
    spend, rev = float(c["spend"]), float(c.get("revenue") or 0)
    orders, leads = float(c.get("orders") or 0), float(c.get("leads") or 0)
    gm = rev - float(c["cogs"]) if c.get("cogs") is not None else rev * float(c.get("margin_rate") or 0)
    aov = rev / orders if orders else None
    margin_per_order = gm / orders if orders else None
    return {"cpl": div(spend, leads), "cac": div(spend, orders), "aov": round(aov, 2) if aov else None,
            "gross_margin": round(gm, 2), "romi": div(gm - spend, spend), "drr": div(spend, rev),
            "ltv": round(margin_per_order * ppc, 2) if margin_per_order is not None else None,
            "cost_per_activated_trial": div(spend, float(c.get("trials_activated") or 0)),
            "lead_to_order": div(orders, leads)}


def compute(data, args):
    as_of = date.fromisoformat(data["as_of"])
    lags = [float(x) for x in data.get("lag_samples_days") or []]
    mw = data.get("maturity_window_days")
    if mw is None:
        if len(lags) < 10:
            raise ValueError("give maturity_window_days or at least 10 lag_samples_days")
        mw = percentile(lags, 0.9)
    mw = float(mw)
    cdf = (lambda k: sum(1 for x in lags if x <= k) / len(lags)) if lags else (lambda k: min(1.0, k / mw))
    min_cdf, target = float(data.get("min_cdf_for_stop", 0.6)), float(data.get("target_romi", 0.0))
    ppc = float(data.get("purchases_per_customer", 1.0))
    rows, by_ch = [], {}
    for c in sorted(data["cohorts"], key=lambda x: (x["channel"], x["cohort_date"])):
        age = (as_of - date.fromisoformat(c["cohort_date"])).days
        if age < 0:
            raise ValueError("cohort %s is in the future" % c["cohort_date"])
        f = cdf(age)
        m = metrics(c, ppc)
        adj_orders = float(c.get("orders") or 0) / f if f > 0 else None
        adj = dict(c, orders=adj_orders, revenue=float(c.get("revenue") or 0) / f if f > 0 else None,
                   cogs=(float(c["cogs"]) / f if f > 0 else None) if c.get("cogs") is not None else None) if f > 0 else None
        m_adj = metrics(adj, ppc) if adj else None
        mature = age >= mw
        romi_used = m["romi"] if mature else (m_adj["romi"] if m_adj else None)
        if mature:
            decision = "stop_or_reduce" if romi_used is not None and romi_used < target else "keep_or_scale"
            reason = "romi_below_target" if decision == "stop_or_reduce" else "romi_ok"
        elif f < min_cdf:
            decision, reason = "hold", "immature_cohort"
        else:
            decision = "watch" if romi_used is not None and romi_used < target else "keep_or_scale"
            reason = "adjusted_by_cdf"
        row = {"channel": c["channel"], "cohort_date": c["cohort_date"], "age_days": age, "cdf_pay": round(f, 4),
               "mature": mature, "metrics": m, "metrics_adjusted": m_adj,
               "orders_adjusted": round(adj_orders, 2) if adj_orders is not None else None,
               "decision": decision, "reason_code": reason,
               "stop_allowed": mature or f >= min_cdf,
               "leading_proxy": {"cost_per_activated_trial": m["cost_per_activated_trial"]} if reason == "immature_cohort" else None}
        rows.append(row)
        by_ch.setdefault(c["channel"], []).append((c, row))
    channels = {}
    for ch, items in sorted(by_ch.items()):
        mat = [c for c, r in items if r["mature"]]
        spend = sum(float(c["spend"]) for c in mat)
        orders = sum(float(c.get("orders") or 0) for c in mat)
        gm = sum(r["metrics"]["gross_margin"] for c, r in items if r["mature"])
        romi = div(gm - spend, spend) if spend else None
        seq = [(float(c["spend"]), r["orders_adjusted"]) for c, r in items if r["orders_adjusted"] is not None]
        marg = None
        if len(seq) >= 2 and seq[-1][1] != seq[-2][1]:
            marg = round((seq[-1][0] - seq[-2][0]) / (seq[-1][1] - seq[-2][1]), 2)
        if not mat:
            decision = "hold"
        else:
            decision = "stop_or_reduce" if romi is not None and romi < target else "keep_or_scale"
        channels[ch] = {"mature_cohorts": len(mat), "immature_cohorts": len(items) - len(mat), "spend_mature": spend,
                        "cac_mature": div(spend, orders), "romi_mature": romi, "marginal_cac_adjusted": marg,
                        "decision": decision}
    return {"as_of": as_of.isoformat(), "maturity_window_days": round(mw, 2), "min_cdf_for_stop": min_cdf,
            "target_romi": target, "cohorts": rows, "channels": channels}


def main():
    ap = Parser(prog=NAME, description="Unit economics per channel/cohort with the immature-cohort lag mask.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
