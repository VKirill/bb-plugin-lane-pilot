#!/usr/bin/env python3
"""Funnel reconcile: ad platform -> web analytics -> CRM -> payments, cross-source gaps and the S-04 cohort mask.

Distilled from the Osipenkov end-to-end analytics course (data tables, Client ID join, CRM stages,
Metrika vs GA4 discrepancies) with Council S-04: conversion rates of cohorts younger than the
maturity window are shown but EXCLUDED from decision rates (reason_code immature_cohort).

Checks per period:
  * funnel inversion: a later stage of the chain larger than the previous one (error);
  * parallel sources: |a - b| / max(a, b) above tolerance (Metrika visits vs GA4 sessions 15%,
    Metrika goals vs CRM leads 10%, ad clicks vs visits 30% by default);
  * Client ID join rate (CRM leads matched to analytics) below 0.8 (warning).

Input JSON: {"as_of", "maturity_window_days": 21,
             "chain": ["ad_clicks", "visits", "leads_crm", "deals", "payments"],
             "parallel": [{"a": "visits", "b": "sessions_ga4", "tolerance": 0.15}],
             "periods": [{"period", "cohort_date", <stage>: n, ...}],
             "client_id_join": {"crm_leads": n, "matched": n}}
Output JSON: periods[] {rates{}, issues[], mature}, decision_rates{}, issues[], join{}, verdict.
"""
import argparse
import json
import sys
from datetime import date

NAME = "funnel_reconcile.py"
VERSION = "1.0.0"
CHAIN = ["ad_clicks", "visits", "leads_crm", "deals", "payments"]
PARALLEL = [{"a": "ad_clicks", "b": "visits", "tolerance": 0.30},
            {"a": "visits", "b": "sessions_ga4", "tolerance": 0.15},
            {"a": "goals_metrika", "b": "leads_crm", "tolerance": 0.10}]


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
    "as_of": "2026-11-11", "maturity_window_days": 21,
    "periods": [
        {"period": "2026-09", "cohort_date": "2026-09-01", "ad_clicks": 18000, "visits": 15400, "sessions_ga4": 14100,
         "goals_metrika": 640, "leads_crm": 610, "deals": 170, "payments": 120},
        {"period": "2026-10", "cohort_date": "2026-10-01", "ad_clicks": 21000, "visits": 17800, "sessions_ga4": 13900,
         "goals_metrika": 720, "leads_crm": 590, "deals": 160, "payments": 175},
        {"period": "2026-11", "cohort_date": "2026-11-01", "ad_clicks": 7000, "visits": 6100, "sessions_ga4": 5800,
         "goals_metrika": 240, "leads_crm": 231, "deals": 31, "payments": 9},
    ],
    "client_id_join": {"crm_leads": 1431, "matched": 1080},
}


def compute(data, args):
    as_of = date.fromisoformat(data["as_of"])
    mw = int(data.get("maturity_window_days", 21))
    chain = data.get("chain") or CHAIN
    parallel = data.get("parallel") or PARALLEL
    out, all_issues = [], []
    sums = {}
    for p in sorted(data["periods"], key=lambda x: x.get("cohort_date") or x["period"]):
        age = (as_of - date.fromisoformat(p["cohort_date"])).days if p.get("cohort_date") else None
        mature = age is None or age >= mw
        present = [s for s in chain if p.get(s) is not None]
        rates, issues = {}, []
        for a, b in zip(present, present[1:]):
            va, vb = float(p[a]), float(p[b])
            rates["%s->%s" % (a, b)] = round(vb / va, 4) if va else None
            if vb > va:
                issues.append({"type": "funnel_inversion", "level": "error", "detail": "%s %g > %s %g" % (b, vb, a, va)})
        for pr in parallel:
            va, vb = p.get(pr["a"]), p.get(pr["b"])
            if va is None or vb is None:
                continue
            gap = abs(float(va) - float(vb)) / max(float(va), float(vb), 1e-9)
            if gap > float(pr["tolerance"]):
                issues.append({"type": "source_gap", "level": "warning",
                               "detail": "%s %g vs %s %g: %.1f%% > %.0f%%" % (pr["a"], va, pr["b"], vb, gap * 100,
                                                                             float(pr["tolerance"]) * 100)})
        for i in issues:
            all_issues.append(dict(i, period=p["period"]))
        out.append({"period": p["period"], "cohort_date": p.get("cohort_date"), "age_days": age, "mature": mature,
                    "rates": rates, "issues": issues,
                    "reason_code": None if mature else "immature_cohort"})
        if mature:
            for s in present:
                sums[s] = sums.get(s, 0.0) + float(p[s])
    present = [s for s in chain if s in sums]
    decision_rates = {"%s->%s" % (a, b): round(sums[b] / sums[a], 4) if sums[a] else None
                      for a, b in zip(present, present[1:])}
    join = None
    cj = data.get("client_id_join")
    if cj:
        rate = float(cj["matched"]) / float(cj["crm_leads"]) if float(cj["crm_leads"]) else 0.0
        join = {"rate": round(rate, 4), "ok": rate >= 0.8}
        if not join["ok"]:
            all_issues.append({"type": "client_id_join", "level": "warning", "period": None,
                               "detail": "only %.1f%% of CRM leads carry an analytics Client ID" % (rate * 100)})
    errors = sum(1 for i in all_issues if i["level"] == "error")
    return {"as_of": as_of.isoformat(), "maturity_window_days": mw, "chain": chain, "periods": out,
            "decision_rates": decision_rates, "decision_basis": "mature cohorts only",
            "issues": all_issues, "join": join, "verdict": "fail" if errors else ("warn" if all_issues else "pass")}


def main():
    ap = Parser(prog=NAME, description="Reconcile funnel stages across ad, analytics and CRM sources.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--strict", action="store_true", help="exit 3 when verdict is fail")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "fail":
        sys.exit(3)


if __name__ == "__main__":
    main()
