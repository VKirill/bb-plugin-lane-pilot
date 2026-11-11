#!/usr/bin/env python3
"""SEO x Direct query bridge (Council §6.4): who should own each query, and the shared-negatives table.

Rules per Direct search query (first match wins):
  (c) paid_insurance   the query's cluster has an active seo_meta_copy lock or a confirmed SEO drop:
                       EPK may keep impressions on it (class D draft, launch only via owner_go);
  (a) negative         organic position 1..2, organic CTR >= 30% and NO competitors in special placement
                       (auction data): add to Direct negatives;
      incrementality_test   same, but competitors are in special placement: test, do not negate;
  (b) seo_opportunity  Direct converts but organic is absent or below top-10: route to seo-cocoon
                       (or seo-template-scale when the cluster has >= 3 converting queries);
      keep             everything else.
(d) shared_negatives = one table (lane_pilot_sp_query_bridge, verdict = 'negative') both specialists read.

Input JSON: {"direct_queries": [{"query", "cluster", "clicks", "cost", "conversions"}],
             "organic": [{"query", "position", "ctr", "clicks"}],
             "auction": {query: {"special_competitors": n}}, "locks": [{"cluster", "kind"}],
             "existing_negatives": [query], "org_ctr_min": 0.30, "org_pos_max": 2}
Output JSON: bridge[] {query, verdict, route, reason, ...}, shared_negatives[], counts{}.
"""
import argparse
import json
import sys

NAME = "seo_ppc_bridge.py"
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
    "direct_queries": [
        {"query": "divanoff отзывы", "cluster": "brand", "clicks": 120, "cost": 3600, "conversions": 2},
        {"query": "divanoff интернет магазин", "cluster": "brand", "clicks": 300, "cost": 6000, "conversions": 9},
        {"query": "угловой диван купить", "cluster": "corner-sofas", "clicks": 900, "cost": 81000, "conversions": 22},
        {"query": "диван кровать с ящиком", "cluster": "sofa-beds", "clicks": 410, "cost": 30500, "conversions": 7},
        {"query": "диван кровать недорого", "cluster": "sofa-beds", "clicks": 380, "cost": 27000, "conversions": 5},
        {"query": "диван кровать еврокнижка", "cluster": "sofa-beds", "clicks": 260, "cost": 19000, "conversions": 3},
        {"query": "как почистить диван", "cluster": "care", "clicks": 90, "cost": 1800, "conversions": 0},
    ],
    "organic": [
        {"query": "divanoff отзывы", "position": 1.2, "ctr": 0.46, "clicks": 800},
        {"query": "divanoff интернет магазин", "position": 1.0, "ctr": 0.62, "clicks": 2100},
        {"query": "угловой диван купить", "position": 4.8, "ctr": 0.06, "clicks": 400},
        {"query": "диван кровать с ящиком", "position": 18.0, "ctr": 0.002, "clicks": 3},
    ],
    "auction": {"divanoff интернет магазин": {"special_competitors": 2}, "divanoff отзывы": {"special_competitors": 0}},
    "locks": [{"cluster": "corner-sofas", "kind": "seo_meta_copy"}],
    "existing_negatives": [],
}


def norm(q):
    return " ".join(str(q).lower().replace("ё", "е").split())


def compute(data, args):
    ctr_min, pos_max = float(data.get("org_ctr_min", 0.30)), float(data.get("org_pos_max", 2))
    org = {norm(r["query"]): r for r in data.get("organic") or []}
    auction = {norm(k): v for k, v in (data.get("auction") or {}).items()}
    locks = {}
    for lk in data.get("locks") or []:
        locks.setdefault(lk["cluster"], []).append(lk["kind"])
    existing = {norm(q) for q in data.get("existing_negatives") or []}
    conv_per_cluster = {}
    for q in data["direct_queries"]:
        if float(q.get("conversions") or 0) > 0:
            conv_per_cluster[q.get("cluster")] = conv_per_cluster.get(q.get("cluster"), 0) + 1
    rows, negatives = [], []
    for q in sorted(data["direct_queries"], key=lambda x: norm(x["query"])):
        key = norm(q["query"])
        o = org.get(key)
        conv = float(q.get("conversions") or 0)
        row = {"query": q["query"], "cluster": q.get("cluster"), "direct_conversions": conv,
               "direct_cost": float(q.get("cost") or 0), "organic_position": o.get("position") if o else None,
               "organic_ctr": o.get("ctr") if o else None, "route": None, "requires_owner_go": False}
        kinds = locks.get(q.get("cluster")) or []
        if kinds:
            row.update({"verdict": "paid_insurance", "route": "mkt-direct (class D draft)", "requires_owner_go": True,
                        "reason": "cluster locked: %s" % ", ".join(sorted(kinds))})
        elif o and float(o["position"]) <= pos_max and float(o["ctr"]) >= ctr_min:
            comp = (auction.get(key) or {}).get("special_competitors")
            if comp == 0:
                row.update({"verdict": "negative", "reason": "organic #%.1f with CTR %.0f%%, no competitors in special placement"
                            % (float(o["position"]), float(o["ctr"]) * 100)})
                if key not in existing:
                    negatives.append({"query": q["query"], "verdict": "negative", "source": NAME, "cluster": q.get("cluster"),
                                      "saved_cost": float(q.get("cost") or 0)})
            else:
                row.update({"verdict": "incrementality_test",
                            "reason": "strong organic, but %s competitors in special placement (or unknown)" % comp})
        elif conv > 0 and (o is None or float(o["position"]) > 10):
            route = "seo-template-scale" if conv_per_cluster.get(q.get("cluster"), 0) >= 3 else "seo-cocoon"
            row.update({"verdict": "seo_opportunity", "route": route,
                        "reason": "Direct converts, organic %s" % ("absent" if o is None else "below top-10")})
        else:
            row.update({"verdict": "keep", "reason": "no bridge rule applies"})
        rows.append(row)
    counts = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    return {"bridge": rows, "shared_negatives": negatives, "counts": counts,
            "table": "lane_pilot_sp_query_bridge", "thresholds": {"org_ctr_min": ctr_min, "org_pos_max": pos_max}}


def main():
    ap = Parser(prog=NAME, description="SEO x Direct query bridge and shared negatives.")
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
