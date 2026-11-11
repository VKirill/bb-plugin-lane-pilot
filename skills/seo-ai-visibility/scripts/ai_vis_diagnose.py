#!/usr/bin/env python3
"""AI-visibility diagnosis: turn per-query scores into a diagnosis code and a prioritized task list.

Distilled from the Kotenkov 4.4 lesson (ai_05_diagnose) and the GEO method bridge: F01 «the site is
cited when it is in the top-10», a target page that is not the cited one, an unreachable top held by
platforms, and an answer that cites us without naming the brand. Free, offline.

Codes (first match wins):
  D0_NO_DATA            no known run for this query
  D8_UNSTABLE           fewer than 2 runs or the answer flips — measure again before acting
  D1_NO_AI_ANSWER       no stable AI answer: classic SEO work, not GEO
  D2_UNREACHABLE_TOP    platforms hold most of the top-10 and no ordinary site is cited: deprioritize
  D7_OK                 cited stably and the target URL is the cited one
  D5_CITED_WRONG_URL    our domain is cited, but not the target page: intent / canonical / internal links
  D6_CITED_NO_BRAND     cited, the brand is never named in the answer text: entity in copy, BrandCore
  D3_TOP10_NOT_CITED    stably in top-10, not cited: answer capsule, passage format, verified facts
  D4_NOT_TOP10          neither top-10 nor cited: improve or create the page first

Input JSON: {"score": <ai_vis_score output>, "panel": [{"qid", "query", "frequency", "target_url"}],
             "platforms": {qid: {"platforms_top10": 7, "ordinary_cited": 0}}}
Output JSON: diagnoses[], tasks[] (priority desc), counts{code: n}.
"""
import argparse
import json
import sys

NAME = "ai_vis_diagnose.py"
VERSION = "1.0.0"
WEIGHT = {"D3_TOP10_NOT_CITED": 1.0, "D5_CITED_WRONG_URL": 0.9, "D4_NOT_TOP10": 0.7, "D6_CITED_NO_BRAND": 0.5,
          "D1_NO_AI_ANSWER": 0.3, "D8_UNSTABLE": 0.2, "D2_UNREACHABLE_TOP": 0.05, "D7_OK": 0.0, "D0_NO_DATA": 0.0}
ACTION = {
    "D1_NO_AI_ANSWER": "classic SEO: no stable AI block for this query, track rankings instead",
    "D2_UNREACHABLE_TOP": "deprioritize: platforms hold the top-10 and the answer cites no ordinary site",
    "D3_TOP10_NOT_CITED": "add an answer capsule (40-60 words) under the H2 that matches the query, verified numbers, FAQ/HowTo schema",
    "D4_NOT_TOP10": "page relevance first: create or rebuild the target page for this intent",
    "D5_CITED_WRONG_URL": "align intent: the cited page competes with the target; fix canonical/internal links or retarget",
    "D6_CITED_NO_BRAND": "name the brand as an entity in the cited passage (BrandCore facts, author, organization schema)",
    "D7_OK": "keep: monitor in the weekly run",
    "D8_UNSTABLE": "collect at least 3 runs before acting",
    "D0_NO_DATA": "re-collect: no known observation",
}


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


def _q(qid, runs, ai, cit_known, cited, tgt_known, tgt, br_known, br, serp, top10, flip=False):
    return {"qid": qid, "engine": "google", "runs": runs, "runs_known": runs, "ai_runs": ai,
            "cit_known_runs": cit_known, "cited_runs": cited, "target_known_runs": tgt_known,
            "target_cited_runs": tgt, "brand_known_runs": br_known, "brand_runs": br,
            "serp_runs": serp, "top10_runs": top10, "presence_flip": flip}


FIXTURE = {
    "score": {"queries": [
        _q("q1", 3, 3, 3, 3, 3, 3, 3, 2, 3, 3),
        _q("q2", 3, 3, 3, 3, 3, 0, 3, 1, 3, 3),
        _q("q3", 3, 3, 3, 0, 3, 0, 3, 0, 3, 3),
        _q("q4", 3, 3, 3, 0, 0, 0, 3, 0, 3, 0),
        _q("q5", 3, 0, 0, 0, 0, 0, 0, 0, 3, 1),
        _q("q6", 3, 3, 3, 0, 0, 0, 3, 0, 3, 0),
        _q("q7", 1, 1, 1, 0, 0, 0, 1, 0, 1, 0),
        _q("q8", 3, 3, 3, 3, 3, 3, 3, 0, 3, 3),
    ]},
    "panel": [
        {"qid": "q1", "query": "продвижение сайтов в москве", "frequency": 5400, "target_url": "https://example-agency.ru/seo/"},
        {"qid": "q2", "query": "аудит сайта цена", "frequency": 1600, "target_url": "https://example-agency.ru/audit/"},
        {"qid": "q3", "query": "seo для интернет-магазина", "frequency": 700, "target_url": "https://example-agency.ru/ecom/"},
        {"qid": "q4", "query": "geo оптимизация", "frequency": 400, "target_url": None},
        {"qid": "q5", "query": "seo агентство отзывы", "frequency": 300},
        {"qid": "q6", "query": "что такое seo", "frequency": 12000},
        {"qid": "q7", "query": "llms.txt пример", "frequency": 90},
        {"qid": "q8", "query": "seo продвижение под ключ", "frequency": 2100, "target_url": "https://example-agency.ru/seo/"},
    ],
    "platforms": {"q6": {"platforms_top10": 8, "ordinary_cited": 0}},
}


def stable(k, n):
    return n > 0 and 2 * k >= n


def diagnose(s, plat):
    if not s.get("runs_known"):
        return "D0_NO_DATA"
    if s["runs_known"] < 2 or s.get("presence_flip"):
        return "D8_UNSTABLE"
    if not stable(s["ai_runs"], s["runs_known"]):
        return "D1_NO_AI_ANSWER"
    in_top = stable(s.get("top10_runs", 0), s.get("serp_runs", 0))
    cited = stable(s.get("cited_runs", 0), s.get("cit_known_runs", 0)) and s.get("cited_runs", 0) > 0
    p = plat or {}
    if (not in_top and not cited and p.get("platforms_top10", 0) * 2 > 10 and p.get("ordinary_cited", 1) == 0):
        return "D2_UNREACHABLE_TOP"
    if cited:
        if s.get("target_known_runs") and s.get("target_cited_runs", 0) == 0:
            return "D5_CITED_WRONG_URL"
        if s.get("brand_known_runs") and s.get("brand_runs", 0) == 0:
            return "D6_CITED_NO_BRAND"
        return "D7_OK"
    return "D3_TOP10_NOT_CITED" if in_top else "D4_NOT_TOP10"


def compute(data, args):
    queries = data["score"]["queries"]
    panel = {p["qid"]: p for p in data.get("panel") or []}
    plats = data.get("platforms") or {}
    max_f = max([float(p.get("frequency") or 0) for p in panel.values()] or [0]) or 1.0
    diagnoses, tasks, counts = [], [], {}
    for s in sorted(queries, key=lambda x: (x.get("engine") or "", x["qid"])):
        code = diagnose(s, plats.get(s["qid"]))
        p = panel.get(s["qid"], {})
        freq = float(p.get("frequency") or 0)
        priority = round(WEIGHT[code] * (0.3 + 0.7 * freq / max_f), 4)
        row = {"qid": s["qid"], "engine": s.get("engine"), "query": p.get("query"), "code": code,
               "action": ACTION[code], "target_url": p.get("target_url"), "priority": priority}
        if code == "D4_NOT_TOP10" and not p.get("target_url"):
            row["action"] = "create the page: no target URL for this intent"
        diagnoses.append(row)
        counts[code] = counts.get(code, 0) + 1
        if priority > 0 and code not in ("D7_OK", "D0_NO_DATA"):
            tasks.append(row)
    tasks.sort(key=lambda t: (-t["priority"], t["qid"]))
    return {"diagnoses": diagnoses, "tasks": tasks[:args.top] if args.top else tasks, "counts": counts}


def main():
    ap = Parser(prog=NAME, description="Diagnose AI-visibility per query and emit prioritized tasks.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--top", type=int, help="keep only the N highest-priority tasks")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
