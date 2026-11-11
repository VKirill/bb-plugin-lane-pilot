#!/usr/bin/env python3
"""Channel isolation: classify a drop mechanism (noise / tracking / demand / ranking / SERP capture) and its scope.

Distilled from the seo-update-forensics method and the Kotenkov 4.7 hypotheses (H0 data, H4 demand,
H5 positions, H6 SERP/AI took the clicks, H7 moved to other pages): isolate organic search from the
other channels before blaming the site, then triage page / template(section) / site scope.

Mechanisms (scored, the strongest wins; noise short-circuits):
  noise         |Poisson z| of organic clicks < 2 — not a drop
  tracking      direct + paid + referral fell as much as organic (within 10 pp): counter / consent / site-wide
  demand        impressions -15% or worse with a stable position (|Δpos| < 0.5): seasonality / demand
  ranking       average position worse by >= 1.0 and impressions down
  serp_capture  impressions and position stable, CTR -20% or worse (AI Overview / SERP features up)
  brand_demand  brand clicks fell >= 2x more than non-brand
Scope: one section holds >= 70% of the loss -> template; one page holds >= 50% -> page; else site.

Input JSON: {"pre": {"organic": {"clicks", "impressions", "position", "ai_overview_share"},
                     "channels": {"direct", "paid", "referral", "social"}, "brand_clicks", "nonbrand_clicks"},
             "post": {...same...},
             "sections": {"/blog/": {"pre": n, "post": n}}, "pages": {url: {"pre": n, "post": n}}}
Output JSON: mechanism, scores{}, scope{level, top}, evidence{}, next_checks[].
"""
import argparse
import json
import math
import sys

NAME = "channel_isolation.py"
VERSION = "1.0.0"
NEXT = {
    "noise": ["no action: within counter noise; keep monitoring"],
    "tracking": ["compare Metrika/GA4 with server logs or CRM leads", "check counter code, consent banner, tag manager release"],
    "demand": ["Wordstat / Google Trends for the head queries", "YoY windows from drop_window_split"],
    "ranking": ["queries and pages with the largest position loss", "update calendar vs drop start", "technical audit of the losing template"],
    "serp_capture": ["live SERP for lost queries: AI Overview / Alice answer, new SERP features", "ai_vis_collect on the lost queries"],
    "brand_demand": ["brand search volume and reputation / PR events", "paid brand campaigns cannibalizing organic"],
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


FIXTURE = {
    "pre": {"organic": {"clicks": 8400, "impressions": 310000, "position": 6.1, "ai_overview_share": 0.12},
            "channels": {"direct": 5200, "paid": 3100, "referral": 900}, "brand_clicks": 2100, "nonbrand_clicks": 6300},
    "post": {"organic": {"clicks": 5900, "impressions": 301000, "position": 6.3, "ai_overview_share": 0.41},
             "channels": {"direct": 5100, "paid": 3050, "referral": 880}, "brand_clicks": 2050, "nonbrand_clicks": 3850},
    "sections": {"/blog/": {"pre": 5200, "post": 3000}, "/catalog/": {"pre": 2600, "post": 2400}, "/": {"pre": 600, "post": 500}},
    "pages": {"https://site.ru/blog/how-to-choose/": {"pre": 1400, "post": 700}},
}


def rel(pre, post):
    return (post - pre) / pre if pre else None


def compute(data, args):
    pre, post = data["pre"], data["post"]
    o0, o1 = pre["organic"], post["organic"]
    c0, c1 = float(o0["clicks"]), float(o1["clicks"])
    z = (c1 - c0) / math.sqrt(c0 + c1) if c0 + c1 > 0 else 0.0
    d_clicks = rel(c0, c1)
    d_impr = rel(float(o0.get("impressions") or 0), float(o1.get("impressions") or 0)) if o0.get("impressions") else None
    d_pos = (float(o1["position"]) - float(o0["position"])) if o0.get("position") is not None and o1.get("position") is not None else None
    ctr0 = c0 / o0["impressions"] if o0.get("impressions") else None
    ctr1 = c1 / o1["impressions"] if o1.get("impressions") else None
    d_ctr = rel(ctr0, ctr1) if ctr0 and ctr1 is not None else None
    ch0, ch1 = pre.get("channels") or {}, post.get("channels") or {}
    other = {k: rel(float(ch0[k]), float(ch1.get(k, 0))) for k in sorted(ch0) if ch0[k]}
    other_mean = sum(other.values()) / len(other) if other else None
    d_brand = rel(float(pre.get("brand_clicks") or 0), float(post.get("brand_clicks") or 0)) if pre.get("brand_clicks") else None
    d_nonbrand = rel(float(pre.get("nonbrand_clicks") or 0), float(post.get("nonbrand_clicks") or 0)) if pre.get("nonbrand_clicks") else None
    d_aio = (float(o1.get("ai_overview_share") or 0) - float(o0.get("ai_overview_share") or 0)) if "ai_overview_share" in o0 else None
    scores = {}
    if abs(z) < 2 or (d_clicks is not None and d_clicks > -0.05):
        mechanism = "noise"
        scores["noise"] = 1.0
    else:
        if other_mean is not None and other_mean <= -0.10 and abs(other_mean - d_clicks) <= 0.10:
            scores["tracking"] = 0.9
        if d_impr is not None and d_impr <= -0.15 and d_pos is not None and abs(d_pos) < 0.5:
            scores["demand"] = 0.8 + min(0.2, -d_impr - 0.15)
        if d_pos is not None and d_pos >= 1.0 and (d_impr is None or d_impr < 0):
            scores["ranking"] = 0.7 + min(0.3, (d_pos - 1.0) / 5)
        if (d_impr is not None and abs(d_impr) < 0.15 and d_pos is not None and abs(d_pos) < 0.5
                and d_ctr is not None and d_ctr <= -0.20):
            scores["serp_capture"] = 0.75 + (0.2 if d_aio is not None and d_aio >= 0.1 else 0.0)
        if d_brand is not None and d_nonbrand is not None and d_brand < 0 and d_brand <= 2 * d_nonbrand:
            scores["brand_demand"] = 0.6
        mechanism = max(sorted(scores), key=lambda k: scores[k]) if scores else "unexplained"
    loss = lambda m: {k: float(v["pre"]) - float(v["post"]) for k, v in (m or {}).items()}
    sec, pages = loss(data.get("sections")), loss(data.get("pages"))
    total_loss = max(c0 - c1, 1e-9)
    scope = {"level": "site", "top": None, "share": None}
    if pages:
        top_p = max(sorted(pages), key=lambda k: pages[k])
        if pages[top_p] / total_loss >= 0.5:
            scope = {"level": "page", "top": top_p, "share": round(pages[top_p] / total_loss, 3)}
    if scope["level"] == "site" and sec:
        top_s = max(sorted(sec), key=lambda k: sec[k])
        if sec[top_s] / total_loss >= 0.7:
            scope = {"level": "template", "top": top_s, "share": round(sec[top_s] / total_loss, 3)}
    r = lambda x: None if x is None else round(x, 4)
    return {"mechanism": mechanism, "scores": {k: round(v, 3) for k, v in scores.items()}, "scope": scope,
            "evidence": {"organic_clicks_delta": r(d_clicks), "poisson_z": round(z, 2), "impressions_delta": r(d_impr),
                         "position_delta": r(d_pos), "ctr_delta": r(d_ctr), "ai_overview_share_delta": r(d_aio),
                         "other_channels_delta": {k: r(v) for k, v in other.items()}, "other_channels_mean": r(other_mean),
                         "brand_delta": r(d_brand), "nonbrand_delta": r(d_nonbrand)},
            "next_checks": NEXT.get(mechanism, ["collect query/page level data: no mechanism matched"])}


def main():
    ap = Parser(prog=NAME, description="Classify the drop mechanism and scope by isolating organic from other channels.")
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
