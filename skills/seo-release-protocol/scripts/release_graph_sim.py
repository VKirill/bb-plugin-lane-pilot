#!/usr/bin/env python3
"""Release graph simulation (Council §6.1 Pre-Mortem for seo-release): redirects and canonicals BEFORE vs AFTER.

Deterministic, $0, runs before any class-L release order. Blocks the release when the AFTER graph has:
  * a redirect chain longer than 1 hop, a redirect loop, or a redirect ending in non-200;
  * a canonical pointing to a URL that redirects, is not 200, or itself canonicalizes elsewhere
    (canonical chain > 1 hop);
  * TOP-20 URL lock: any of the 20 URLs with most clicks changes its status away from 200 or changes
    its canonical, unless the plan explicitly allows that change.
Violations already present BEFORE are reported as "preexisting" (warning) so the release is judged on
what it changes.

Input JSON: {"before": {url: {"status": 200, "location": null, "canonical": url}},
             "after":  {url: {...}}, "clicks": {url: n} | "top20": [url],
             "allow": [{"url": u, "change": "status|canonical"}]}
Output JSON: verdict (pass|block), violations[], preexisting[], top20[], stats{}.
"""
import argparse
import json
import sys
from urllib.parse import urljoin, urlsplit, urlunsplit

NAME = "release_graph_sim.py"
VERSION = "1.0.0"
MAX_HOPS = 1


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


S = "https://shop.ru"
FIXTURE = {
    "before": {
        S + "/": {"status": 200, "canonical": S + "/"},
        S + "/sofas/": {"status": 200, "canonical": S + "/sofas/"},
        S + "/chairs/": {"status": 200, "canonical": S + "/chairs/"},
        S + "/old-blog/": {"status": 301, "location": S + "/blog/"},
        S + "/blog/": {"status": 200, "canonical": S + "/blog/"},
    },
    "after": {
        S + "/": {"status": 200, "canonical": S + "/"},
        S + "/sofas/": {"status": 301, "location": S + "/catalog/sofas/"},
        S + "/catalog/sofas/": {"status": 200, "canonical": S + "/catalog/sofas/"},
        S + "/chairs/": {"status": 200, "canonical": S + "/catalog/chairs/"},
        S + "/catalog/chairs/": {"status": 301, "location": S + "/catalog/chairs-new/"},
        S + "/catalog/chairs-new/": {"status": 200, "canonical": S + "/catalog/chairs-new/"},
        S + "/old-blog/": {"status": 301, "location": S + "/blog/"},
        S + "/blog/": {"status": 301, "location": S + "/journal/"},
        S + "/journal/": {"status": 200, "canonical": S + "/journal/"},
    },
    "clicks": {S + "/": 9000, S + "/sofas/": 4100, S + "/chairs/": 2600, S + "/blog/": 300},
    "allow": [{"url": S + "/sofas/", "change": "status"}],
}


def norm(url, base=None):
    if not url:
        return None
    u = urljoin(base, url) if base else url
    p = urlsplit(u)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", p.query, ""))


def load_graph(raw):
    g = {}
    for url, node in raw.items():
        key = norm(url)
        g[key] = {"status": int(node.get("status", 200)), "location": norm(node.get("location"), key),
                  "canonical": norm(node.get("canonical"), key)}
    return g


def follow(g, url):
    """(hops, final_url, final_status, loop)."""
    seen, cur, hops = [url], url, 0
    while cur in g and 300 <= g[cur]["status"] < 400:
        nxt = g[cur]["location"]
        if not nxt:
            return hops, cur, g[cur]["status"], False
        hops += 1
        if nxt in seen:
            return hops, nxt, None, True
        seen.append(nxt)
        cur = nxt
    return hops, cur, g[cur]["status"] if cur in g else None, False


def check(g):
    out = []
    for url in sorted(g):
        node = g[url]
        if 300 <= node["status"] < 400:
            hops, final, status, loop = follow(g, url)
            if loop:
                out.append({"type": "redirect_loop", "url": url, "detail": "loops at %s" % final})
            elif hops > MAX_HOPS:
                out.append({"type": "redirect_chain", "url": url, "detail": "%d hops to %s" % (hops, final)})
            elif status is not None and status != 200:
                out.append({"type": "redirect_to_non200", "url": url, "detail": "%s answers %s" % (final, status)})
            elif status is None:
                out.append({"type": "redirect_target_unknown", "url": url, "detail": "%s not in graph" % final,
                            "severity": "warning"})
        elif node["status"] == 200 and node["canonical"] and node["canonical"] != url:
            tgt = node["canonical"]
            t = g.get(tgt)
            if t is None:
                out.append({"type": "canonical_target_unknown", "url": url, "detail": tgt, "severity": "warning"})
            elif 300 <= t["status"] < 400:
                out.append({"type": "canonical_to_redirect", "url": url, "detail": "%s redirects" % tgt})
            elif t["status"] != 200:
                out.append({"type": "canonical_to_non200", "url": url, "detail": "%s answers %s" % (tgt, t["status"])})
            elif t["canonical"] and t["canonical"] != tgt:
                out.append({"type": "canonical_chain", "url": url, "detail": "%s -> %s" % (tgt, t["canonical"])})
    for v in out:
        v.setdefault("severity", "error")
    return out


def compute(data, args):
    if not isinstance(data, dict) or not data.get("before") or not data.get("after"):
        raise KeyError("non-empty 'before' and 'after' URL graphs are required")
    before, after = load_graph(data["before"]), load_graph(data["after"])
    if data.get("top20"):
        top = [norm(u) for u in data["top20"]][:20]
    else:
        clicks = {norm(u): float(n) for u, n in (data.get("clicks") or {}).items()}
        top = [u for u, _ in sorted(clicks.items(), key=lambda kv: (-kv[1], kv[0]))[:20]]
    allow = {(norm(a["url"]), a["change"]) for a in data.get("allow") or []}
    pre = {(v["type"], v["url"]) for v in check(before)}
    violations, preexisting = [], []
    for v in check(after):
        (preexisting if (v["type"], v["url"]) in pre else violations).append(v)
    for u in top:
        b, a = before.get(u), after.get(u)
        if b is None:
            continue
        if a is None:
            violations.append({"type": "top20_removed", "url": u, "detail": "missing in AFTER graph", "severity": "error"})
            continue
        if b["status"] == 200 and a["status"] != 200 and (u, "status") not in allow:
            violations.append({"type": "top20_status_change", "url": u, "severity": "error",
                               "detail": "200 -> %s without plan permission" % a["status"]})
        if a["status"] == 200 and b["canonical"] != a["canonical"] and (u, "canonical") not in allow:
            violations.append({"type": "top20_canonical_change", "url": u, "severity": "error",
                               "detail": "%s -> %s without plan permission" % (b["canonical"], a["canonical"])})
    errors = [v for v in violations if v["severity"] == "error"]
    return {"verdict": "block" if errors else "pass", "violations": violations, "preexisting": preexisting,
            "top20": top, "allowed": sorted("%s:%s" % x for x in allow),
            "stats": {"before_urls": len(before), "after_urls": len(after), "errors": len(errors),
                      "warnings": len(violations) - len(errors), "max_hops": MAX_HOPS}}


def main():
    ap = Parser(prog=NAME, description="Pre-mortem of a release: redirect/canonical graph and TOP-20 URL lock.")
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
