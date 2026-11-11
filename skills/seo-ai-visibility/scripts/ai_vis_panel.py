#!/usr/bin/env python3
"""AI-visibility panel: pick the fixed query panel (GATE 1) that every AI-visibility run measures.

Distilled from the Kotenkov 4.4 «ai-visibility» lesson (step ai_01_panel). The panel comes from the
content plan, not from imagination: clusters the plan will change first (baseline before work), then
clusters that already have a page, then the rest by demand. Navigational queries with a foreign brand
and deferred clusters without our page are excluded and listed with a reason. The panel is
deterministic: the same input always yields the same qids and panel_hash.

Input JSON:
  {"domain": "site.ru", "size": 100, "engines": ["google", "yandex"], "include_nav": false,
   "include_deferred": false, "drop": ["query to drop"],
   "queries": [{"query", "cluster", "frequency", "intent", "target_url", "in_plan", "has_page",
                "deferred", "brand_nav"}]}
Output JSON: panel[], panel_hash, counts{}, excluded[], warnings[].

  ai_vis_panel.py --fixture
  ai_vis_panel.py --input queries.json --size 120
"""
import argparse
import hashlib
import json
import re
import sys

NAME = "ai_vis_panel.py"
VERSION = "1.0.0"
METHOD_MIN, METHOD_MAX = 50, 200          # method: 50–200 fixed queries per language/region/engine
GROUPS = ("in_plan", "deferred_with_page", "has_page", "demand")


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
    "domain": "example-agency.ru", "size": 6, "engines": ["google", "yandex"],
    "queries": [
        {"query": "продвижение сайтов в Москве", "cluster": "seo-msk", "frequency": 5400, "intent": "commercial",
         "target_url": "https://example-agency.ru/seo/", "in_plan": True, "has_page": True},
        {"query": "в москве продвижение сайтов", "cluster": "seo-msk", "frequency": 300, "intent": "commercial"},
        {"query": "что такое ai overview", "cluster": "aio", "frequency": 900, "intent": "informational",
         "in_plan": True},
        {"query": "аудит сайта цена", "cluster": "audit", "frequency": 1600, "intent": "commercial",
         "target_url": "https://example-agency.ru/audit/", "has_page": True},
        {"query": "semrush вход", "cluster": "nav", "frequency": 8000, "brand_nav": True},
        {"query": "geo оптимизация сайта", "cluster": "geo", "frequency": 400, "deferred": True,
         "has_page": True, "target_url": "https://example-agency.ru/geo/"},
        {"query": "seo для интернет-магазина", "cluster": "ecom", "frequency": 700},
        {"query": "что такое seo", "cluster": "wiki", "frequency": 12000, "deferred": True},
    ],
}


def token_key(text):
    tokens = re.findall(r"[0-9a-zа-я]+", text.lower().replace("ё", "е"))
    return " ".join(sorted(set(tokens)))


def group_of(q):
    if q.get("in_plan"):
        return "in_plan"
    if q.get("deferred") and q.get("has_page"):
        return "deferred_with_page"
    if q.get("has_page"):
        return "has_page"
    return "demand"


def compute(data, args):
    size = int(args.size or data.get("size") or 100)
    if size <= 0:
        raise ValueError("size must be positive")
    include_nav = bool(args.include_nav or data.get("include_nav"))
    include_deferred = bool(args.include_deferred or data.get("include_deferred"))
    drop = {token_key(x) for x in (data.get("drop") or [])}
    queries = data["queries"]
    if not isinstance(queries, list) or not queries:
        raise ValueError("queries must be a non-empty list")
    excluded, candidates = [], []
    for q in queries:
        text = str(q["query"]).strip()
        if not text:
            raise ValueError("empty query text")
        key = token_key(text)
        if key in drop:
            excluded.append({"query": text, "reason": "dropped_by_owner"})
        elif q.get("brand_nav") and not include_nav:
            excluded.append({"query": text, "reason": "navigational_foreign_brand"})
        elif q.get("deferred") and not q.get("has_page") and not include_deferred:
            excluded.append({"query": text, "reason": "deferred_without_our_page"})
        else:
            candidates.append((GROUPS.index(group_of(q)), -float(q.get("frequency") or 0), text, key, q))
    candidates.sort(key=lambda c: (c[0], c[1], c[2]))
    seen, panel = set(), []
    for gi, negf, text, key, q in candidates:
        if key in seen:
            excluded.append({"query": text, "reason": "duplicate_token_set"})
            continue
        seen.add(key)
        if len(panel) >= size:
            excluded.append({"query": text, "reason": "over_panel_size"})
            continue
        panel.append({"qid": "q" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10], "query": text,
                      "cluster": q.get("cluster"), "group": GROUPS[gi], "frequency": -negf,
                      "intent": q.get("intent"), "target_url": q.get("target_url")})
    warnings = []
    if len(panel) < METHOD_MIN:
        warnings.append("panel_below_method_min: %d < %d queries; shares will have wide intervals" % (len(panel), METHOD_MIN))
    if len(panel) > METHOD_MAX:
        warnings.append("panel_above_method_max: %d > %d queries; paid collection cost grows" % (len(panel), METHOD_MAX))
    if not any(p["target_url"] for p in panel):
        warnings.append("no_target_urls: target_url_cited cannot be measured")
    panel_hash = hashlib.sha1("|".join(sorted(p["qid"] for p in panel)).encode("utf-8")).hexdigest()[:16]
    counts = {"input": len(queries), "selected": len(panel), "excluded": len(excluded),
              "by_group": {g: sum(1 for p in panel if p["group"] == g) for g in GROUPS}}
    return {"domain": data.get("domain"), "engines": data.get("engines") or ["google", "yandex"],
            "panel": panel, "panel_hash": panel_hash, "counts": counts,
            "excluded": sorted(excluded, key=lambda e: (e["reason"], e["query"])), "warnings": warnings}


def main():
    ap = Parser(prog=NAME, description="Build the fixed AI-visibility query panel (deterministic qids).")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--size", type=int, help="panel size (default: input size or 100)")
    ap.add_argument("--include-nav", action="store_true", help="keep navigational foreign-brand queries")
    ap.add_argument("--include-deferred", action="store_true", help="keep deferred clusters without our page")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
