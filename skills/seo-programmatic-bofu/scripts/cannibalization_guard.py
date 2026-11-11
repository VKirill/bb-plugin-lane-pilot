#!/usr/bin/env python3
"""Cannibalization guard: Council S-06 information-gain gate, stages 1-2, plus live GSC cannibalization.

A programmatic page earns its URL only when it is a different SERP and carries new verified facts:
  stage 1  serp_overlap(top10 candidate, top10 parent) < 0.40, else the intent is absorbed as an H2
           of the parent (merge_into_parent_h2); two candidates overlapping >= 0.40 merge into the
           higher-demand one;
  stage 2  unique_verified_facts >= 3: facts verified in fact_registry / BrandCore and absent from the
           parent page, else needs_facts (draft stays a draft).
Stage 3 (canary batching by indexation) is cf_batch_handoff.py.
Also reports queries where 2+ own URLs each take >= 20% of impressions (existing cannibalization).

Input JSON: {"parent": {"url", "top10": [url], "facts": [key]},
             "candidates": [{"id", "url", "query", "frequency", "top10": [url], "facts": [key]}],
             "fact_registry": {key: {"verified": true, "source": "brandcore"}},
             "gsc_rows": [{"query", "url", "impressions"}], "max_overlap": 0.40, "min_facts": 3}
Output JSON: decisions[] {id, decision, serp_overlap, unique_verified_facts, reasons[]},
             gsc_conflicts[], verdict (pass|partial|block).
"""
import argparse
import json
import sys
from urllib.parse import urlsplit

NAME = "cannibalization_guard.py"
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


def _serp(*hosts):
    return ["https://%s/" % h for h in hosts]


FIXTURE = {
    "parent": {"url": "https://crm.ru/amocrm/", "top10": _serp("amocrm.ru", "vc.ru", "habr.com", "crm.ru", "otzovik.com",
                                                                "tadviser.ru", "g2.com", "capterra.com", "rb.ru", "1c.ru"),
               "facts": ["amocrm_price_2026"]},
    "candidates": [
        {"id": "amocrm-cena", "url": "https://crm.ru/amocrm/cena/", "query": "amocrm цена", "frequency": 1900,
         "top10": _serp("amocrm.ru", "vc.ru", "habr.com", "crm.ru", "otzovik.com", "tadviser.ru", "x1.ru", "x2.ru", "x3.ru", "x4.ru"),
         "facts": ["amocrm_price_2026", "amocrm_seat_min"]},
        {"id": "amocrm-vs-bitrix24", "url": "https://crm.ru/amocrm-vs-bitrix24/", "query": "amocrm vs bitrix24",
         "frequency": 880, "top10": _serp("vc.ru", "b24.ru", "s1.ru", "s2.ru", "s3.ru", "s4.ru", "s5.ru", "s6.ru", "s7.ru", "s8.ru"),
         "facts": ["b24_free_tier_users", "amocrm_seat_min", "b24_modules_count", "migration_days_median"]},
        {"id": "amocrm-stomatologiya", "url": "https://crm.ru/amocrm/stomatologiya/", "query": "crm для стоматологии",
         "frequency": 260, "top10": _serp("d1.ru", "d2.ru", "d3.ru", "d4.ru", "d5.ru", "d6.ru", "d7.ru", "d8.ru", "d9.ru", "d10.ru"),
         "facts": ["dental_case_noshow", "unverified_claim"]},
    ],
    "fact_registry": {"amocrm_price_2026": {"verified": True, "source": "brandcore"},
                      "amocrm_seat_min": {"verified": True, "source": "vendor pricing page"},
                      "b24_free_tier_users": {"verified": True, "source": "vendor pricing page"},
                      "b24_modules_count": {"verified": True, "source": "vendor docs"},
                      "migration_days_median": {"verified": True, "source": "own projects 2025-2026"},
                      "dental_case_noshow": {"verified": True, "source": "client case"},
                      "unverified_claim": {"verified": False}},
    "gsc_rows": [{"query": "amocrm тарифы", "url": "https://crm.ru/amocrm/", "impressions": 5200},
                 {"query": "amocrm тарифы", "url": "https://crm.ru/blog/amocrm-prices/", "impressions": 3100},
                 {"query": "amocrm отзывы", "url": "https://crm.ru/amocrm/", "impressions": 900}],
}


def key(url):
    p = urlsplit(url)
    h = p.netloc.lower()
    return (h[4:] if h.startswith("www.") else h) + (p.path.rstrip("/") or "/")


def overlap(a, b):
    sa, sb = {key(u) for u in a[:10]}, {key(u) for u in b[:10]}
    return len(sa & sb) / 10.0 if sa and sb else None


def compute(data, args):
    max_ov = float(data.get("max_overlap", 0.40))
    min_facts = int(data.get("min_facts", 3))
    parent = data["parent"]
    reg = data.get("fact_registry") or {}
    parent_facts = set(parent.get("facts") or [])
    cands = sorted(data["candidates"], key=lambda c: (-float(c.get("frequency") or 0), str(c["id"])))
    decisions, kept = [], []
    for c in cands:
        reasons = []
        ov = overlap(c.get("top10") or [], parent.get("top10") or [])
        uf = sorted(f for f in set(c.get("facts") or []) - parent_facts if (reg.get(f) or {}).get("verified"))
        row = {"id": c["id"], "url": c.get("url"), "query": c.get("query"), "serp_overlap": ov,
               "unique_verified_facts": len(uf), "unique_fact_keys": uf}
        if ov is None:
            row["decision"] = "needs_serp"
            reasons.append("no top-10 for candidate or parent: stage 1 cannot run")
        elif ov >= max_ov:
            row["decision"] = "merge_into_parent_h2"
            reasons.append("SERP overlap %.2f >= %.2f with parent %s" % (ov, max_ov, parent.get("url")))
        else:
            twin = next((k for k in kept if (overlap(c.get("top10") or [], k.get("top10") or []) or 0) >= max_ov), None)
            if twin:
                row["decision"] = "merge_into_sibling"
                row["merge_into"] = twin["id"]
                reasons.append("SERP overlap >= %.2f with higher-demand candidate %s" % (max_ov, twin["id"]))
            elif len(uf) < min_facts:
                row["decision"] = "needs_facts"
                reasons.append("%d unique verified facts < %d" % (len(uf), min_facts))
            else:
                row["decision"] = "publish_candidate"
                kept.append(c)
        row["reasons"] = reasons
        decisions.append(row)
    by_q = {}
    for r in data.get("gsc_rows") or []:
        by_q.setdefault(r["query"], []).append(r)
    conflicts = []
    for q in sorted(by_q):
        rows = by_q[q]
        tot = sum(float(r["impressions"]) for r in rows) or 1.0
        big = [r for r in rows if float(r["impressions"]) / tot >= 0.20]
        if len({key(r["url"]) for r in big}) >= 2:
            conflicts.append({"query": q, "urls": sorted({r["url"] for r in big}),
                              "shares": {r["url"]: round(float(r["impressions"]) / tot, 3) for r in big}})
    ok = sum(1 for d in decisions if d["decision"] == "publish_candidate")
    verdict = "pass" if ok == len(decisions) else ("partial" if ok else "block")
    return {"decisions": decisions, "gsc_conflicts": conflicts, "verdict": verdict,
            "thresholds": {"max_overlap": max_ov, "min_facts": min_facts},
            "counts": {d: sum(1 for x in decisions if x["decision"] == d) for d in sorted({x["decision"] for x in decisions})}}


def main():
    ap = Parser(prog=NAME, description="Information-gain gate (SERP overlap + verified facts) and GSC cannibalization.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--strict", action="store_true", help="exit 3 when verdict is block")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "block":
        sys.exit(3)


if __name__ == "__main__":
    main()
