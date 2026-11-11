#!/usr/bin/env python3
"""AI-visibility score: per-query and per-engine shares over several collection runs (offline, free).

Distilled from the Kotenkov 4.4 lesson (ai_04_score). Shares are counted BY QUERY, not by observation:
repeats of one query are not independent, an interval over observations would be falsely narrow.
A query is «stable» in a state when it held in at least half of its runs (2k >= n). Every share has
its own denominator and a Wilson 95% interval. Unknown (null) never enters a denominator.

Input JSON: {"domain": "site.ru",
             "runs": [{"run": "r1", "observations": [<ai_vis_collect observation>]}]}
         or {"domain": ..., "observations": [{..., "run": "r1"}]}
Output JSON: engines{engine: summary}, queries[] (per qid × engine), runs_used.
"""
import argparse
import json
import math
import sys
from itertools import combinations
from urllib.parse import urlsplit

NAME = "ai_vis_score.py"
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


def _obs(qid, run, ai, cited, brand, rank, hosts, engine="google", target=None):
    urls = ["https://%s/" % h for h in hosts]
    return {"qid": qid, "run": run, "engine": engine, "status": "ok", "ai_answer_present": ai,
            "project_domain_cited": cited, "target_url_cited": target, "brand_mentioned": brand,
            "project_best_rank": rank, "top10": rank is not None, "top3": rank is not None and rank <= 3,
            "sources_status": "ok" if hosts else ("missing" if ai else "none"), "cited_urls": urls}


FIXTURE = {"domain": "example-agency.ru", "observations": [
    _obs("q1", "r1", True, True, True, 1, ["example-agency.ru", "cossa.ru"], target=True),
    _obs("q1", "r2", True, True, False, 2, ["example-agency.ru", "vc.ru"], target=True),
    _obs("q1", "r3", True, False, False, 2, ["cossa.ru", "vc.ru"], target=False),
    _obs("q2", "r1", True, None, False, None, []),
    _obs("q2", "r2", True, False, False, None, ["wikipedia.org"]),
    _obs("q2", "r3", False, False, False, None, []),
    _obs("q3", "r1", True, False, False, 4, ["ru.wikipedia.org", "habr.com"], target=False),
    _obs("q3", "r2", True, False, False, 5, ["habr.com"], target=False),
]}


def wilson(k, n, z=1.959964):
    if n == 0:
        return {"k": 0, "n": 0, "p": None, "lo": None, "hi": None}
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return {"k": k, "n": n, "p": round(p, 4), "lo": round(max(0.0, centre - half), 4),
            "hi": round(min(1.0, centre + half), 4)}


def stable(k, n):
    return n > 0 and 2 * k >= n


def host(url):
    h = urlsplit(url).netloc.lower()
    return h[4:] if h.startswith("www.") else h


def jaccard(a, b):
    if not a and not b:
        return None
    return len(a & b) / len(a | b)


def query_level(obs):
    known = [o for o in obs if o.get("ai_answer_present") is not None]
    ans = [o for o in known if o["ai_answer_present"]]
    cit_known = [o for o in ans if o.get("project_domain_cited") is not None]
    tgt_known = [o for o in ans if o.get("target_url_cited") is not None]
    br_known = [o for o in ans if o.get("brand_mentioned") is not None]
    serp = [o for o in obs if o.get("top10") is not None]
    ranks = sorted(o["project_best_rank"] for o in serp if o.get("project_best_rank"))
    sets = [set(host(u) for u in o.get("cited_urls") or []) for o in ans if o.get("sources_status") == "ok"]
    pairs = [j for a, b in combinations(sets, 2) for j in [jaccard(a, b)] if j is not None]
    return {
        "runs": len(obs), "runs_known": len(known), "ai_runs": len(ans),
        "cit_known_runs": len(cit_known), "cited_runs": sum(1 for o in cit_known if o["project_domain_cited"]),
        "target_known_runs": len(tgt_known), "target_cited_runs": sum(1 for o in tgt_known if o["target_url_cited"]),
        "brand_known_runs": len(br_known), "brand_runs": sum(1 for o in br_known if o["brand_mentioned"]),
        "serp_runs": len(serp), "top10_runs": sum(1 for o in serp if o["top10"]),
        "top3_runs": sum(1 for o in serp if o.get("top3")),
        "best_rank": ranks[0] if ranks else None,
        "median_rank": (ranks[len(ranks) // 2] if len(ranks) % 2 else
                        (ranks[len(ranks) // 2 - 1] + ranks[len(ranks) // 2]) / 2) if ranks else None,
        "sources_missing_runs": sum(1 for o in ans if o.get("sources_status") == "missing"),
        "jaccard_mean": round(sum(pairs) / len(pairs), 3) if pairs else None,
        "presence_flip": len({o["ai_answer_present"] for o in known}) > 1,
    }


def engine_summary(qs):
    q = [s for s in qs if s["runs_known"]]
    answered = [s for s in q if s["ai_runs"]]
    cit_q = [s for s in answered if s["cit_known_runs"]]
    tgt_q = [s for s in answered if s["target_known_runs"]]
    br_q = [s for s in answered if s["brand_known_runs"]]
    serp_q = [s for s in qs if s["serp_runs"]]
    multi = [s for s in q if s["runs_known"] >= 2]
    jac = [s["jaccard_mean"] for s in q if s["jaccard_mean"] is not None]
    return {
        "queries": len(qs), "queries_with_data": len(q),
        "top10_stable": wilson(sum(1 for s in serp_q if stable(s["top10_runs"], s["serp_runs"])), len(serp_q)),
        "top3_stable": wilson(sum(1 for s in serp_q if stable(s["top3_runs"], s["serp_runs"])), len(serp_q)),
        "answer_any": wilson(len(answered), len(q)),
        "answer_stable": wilson(sum(1 for s in q if stable(s["ai_runs"], s["runs_known"])), len(q)),
        "cited_any": wilson(sum(1 for s in cit_q if s["cited_runs"]), len(cit_q)),
        "cited_stable": wilson(sum(1 for s in cit_q if stable(s["cited_runs"], s["cit_known_runs"])), len(cit_q)),
        "target_cited_any": wilson(sum(1 for s in tgt_q if s["target_cited_runs"]), len(tgt_q)),
        "cited_if_top10": wilson(sum(1 for s in cit_q if s["top10_runs"] and s["cited_runs"]),
                                 sum(1 for s in cit_q if s["top10_runs"])),
        "cited_if_not_top10": wilson(sum(1 for s in cit_q if s["serp_runs"] and not s["top10_runs"] and s["cited_runs"]),
                                     sum(1 for s in cit_q if s["serp_runs"] and not s["top10_runs"])),
        "brand_any": wilson(sum(1 for s in br_q if s["brand_runs"]), len(br_q)),
        "presence_flip": wilson(sum(1 for s in multi if s["presence_flip"]), len(multi)),
        "jaccard_mean": round(sum(jac) / len(jac), 3) if jac else None,
        "cit_unknown_queries": len(answered) - len(cit_q),
    }


def compute(data, args):
    obs = list(data.get("observations") or [])
    for run in data.get("runs") or []:
        obs += [dict(o, run=run.get("run")) for o in run["observations"]]
    if not obs:
        raise ValueError("no observations")
    days = set(args.runs.split(",")) if args.runs else None
    obs = [o for o in obs if o.get("status", "ok") == "ok" and (days is None or o.get("run") in days)]
    grouped = {}
    for o in obs:
        grouped.setdefault((o.get("engine") or "google", o["qid"]), []).append(o)
    queries, by_engine = [], {}
    for (engine, qid) in sorted(grouped):
        s = query_level(grouped[(engine, qid)])
        s.update({"engine": engine, "qid": qid})
        queries.append(s)
        by_engine.setdefault(engine, []).append(s)
    return {"domain": data.get("domain"), "runs_used": sorted({str(o.get("run")) for o in obs}),
            "engines": {e: engine_summary(v) for e, v in sorted(by_engine.items())}, "queries": queries}


def main():
    ap = Parser(prog=NAME, description="Score AI-visibility per query and engine (Wilson intervals).")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--runs", help="only these run ids, comma separated")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
