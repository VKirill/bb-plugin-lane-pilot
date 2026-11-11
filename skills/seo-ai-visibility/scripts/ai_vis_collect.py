#!/usr/bin/env python3
"""AI-visibility collector (GATE 2): one run of the panel through a SERP XML provider with the AI block.

Distilled from the Kotenkov 4.4 lesson (ai_03_collect) and the XMLRiver API rule. Three layers are
never mixed: the organic top-10, the sources of the AI answer, and the brand inside the answer text.
Unknown is not «no»: an answer without a source list gives project_domain_cited = null, an empty
answer body gives brand_mentioned = null.

Providers and credentials (environment only, never in files or arguments):
  xmlstock  XMLSTOCK_USER + XMLSTOCK_KEY
  xmlriver  XMLRIVER_USER + XMLRIVER_KEY   (XMLRIVER_KEY may also be "user:key")

Modes:
  --fixture                 parse the built-in XML samples, no network
  --input F (with "raw")    offline: parse saved provider responses {qid: xml}
  --input F                 plan only: count and cost estimate, nothing is spent
  --input F --go            live paid collection (needs the env credentials above)

Input JSON: {"domain", "aliases": [], "engine": "google|yandex", "provider": "xmlriver|xmlstock",
             "region": "213", "panel": [{"qid", "query", "target_url"}], "raw": {qid: "<xml>"}}
Output JSON: mode, observations[] (qid, engine, ai_answer_present, sources_status, cited_urls,
             project_domain_cited, target_url_cited, brand_mentioned, organic_top10, project_best_rank),
             totals{}, cost{}.
"""
import argparse
import base64
import binascii
import html
from html.parser import HTMLParser
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

NAME = "ai_vis_collect.py"
VERSION = "1.0.0"
RUB_PER_1000_AI = 35.0          # live demo 2026-10: ~35 RUB / 1000 requests with ai=1
ENDPOINTS = {
    ("xmlriver", "google"): "https://xmlriver.com/search/xml",
    ("xmlriver", "yandex"): "https://xmlriver.com/search_yandex/xml",
    ("xmlstock", "google"): "https://xmlstock.com/google/xml/",
    ("xmlstock", "yandex"): "https://xmlstock.com/yandex/xml/",
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


def b64(text):
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _fixture():
    ans1 = ('<p>Продвижение сайтов в Москве стоит от 40 000 ₽ в месяц, агентство Example Agency '
            'даёт аудит бесплатно.</p><a data-suuid="1" href="https://example-agency.ru/seo/">example-agency.ru</a>'
            '<a href="https://www.cossa.ru/seo-price/">Cossa</a>')
    ans2 = '<p>AI Overview — блок ответа ИИ над выдачей.</p>'
    docs = "".join("<doc><url>https://site%d.ru/</url></doc>" % i for i in range(1, 10))
    return {
        "domain": "example-agency.ru", "aliases": ["Example Agency", "Экзампл"], "engine": "google",
        "provider": "xmlriver",
        "panel": [
            {"qid": "q1", "query": "продвижение сайтов в москве", "target_url": "https://example-agency.ru/seo/"},
            {"qid": "q2", "query": "что такое ai overview", "target_url": None},
            {"qid": "q3", "query": "аудит сайта цена", "target_url": "https://example-agency.ru/audit/"},
        ],
        "raw": {
            "q1": ("<yandexsearch><response><results><grouping>"
                   "<group><doc><url>https://example-agency.ru/seo/</url></doc></group>" + docs +
                   "</grouping></results><ai><answer>%s</answer><item><url>https://example-agency.ru/seo/</url></item>"
                   "<item><url>https://www.cossa.ru/seo-price/</url></item></ai></response></yandexsearch>") % b64(ans1),
            "q2": ("<yandexsearch><response><results><grouping>" + docs + "</grouping></results>"
                   "<ai><answer>%s</answer></ai></response></yandexsearch>") % b64(ans2),
            "q3": '<yandexsearch><response><error code="15">no results</error></response></yandexsearch>',
        },
    }


FIXTURE = _fixture()


def host_of(url):
    h = urllib.parse.urlsplit(url if "//" in url else "https://" + url).netloc.lower()
    return h[4:] if h.startswith("www.") else h


def same_page(a, b):
    def norm(u):
        p = urllib.parse.urlsplit(u)
        return host_of(u) + (p.path.rstrip("/") or "/")
    return bool(a and b) and norm(a) == norm(b)


def is_own(url, domain):
    h = host_of(url)
    return h == domain or h.endswith("." + domain)


def decode_html(text):
    raw = (text or "").strip()
    if not raw:
        return ""
    try:
        return base64.b64decode(raw, validate=True).decode("utf-8")
    except (binascii.Error, ValueError):
        return raw                      # provider sent plain HTML/CDATA


class Answer(HTMLParser):
    """Answer body without source chips: anchor text is a source label, not the answer (brand false-positives)."""

    def __init__(self, fragment):
        super().__init__(convert_charrefs=True)
        self.hrefs, self.parts, self._a, self._skip = [], [], 0, 0
        self.feed(fragment or "")
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._a += 1
            href = dict(attrs).get("href") or ""
            if href.startswith(("http://", "https://")):
                self.hrefs.append(href)
        elif tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag == "a" and self._a:
            self._a -= 1
        elif tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._a and not self._skip:
            self.parts.append(data)

    def text(self):
        return " ".join(" ".join(self.parts).split())


def parse(xml_text, engine):
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        return {"status": "parse_error", "detail": str(exc)}
    err = root.find(".//error")
    if err is not None:
        return {"status": "provider_error", "detail": "%s %s" % (err.get("code"), (err.text or "").strip())}
    organic = [u.text.strip() for u in root.findall(".//doc/url") if u.text][:10]
    ai = root.find(".//ai")
    if ai is None:
        return {"status": "ok", "ai": False, "organic": organic, "body": None, "cited": []}
    if engine == "google":
        body_html = decode_html((ai.findtext("answer") or ""))
    else:
        body_html = " ".join(decode_html(c.text or "") for c in ai.findall(".//item/content"))
    cited = [u.text.strip() for u in ai.findall(".//item/url") if u.text]
    answer = Answer(body_html)
    cited += answer.hrefs
    uniq = []
    for u in cited:
        if u not in uniq:
            uniq.append(u)
    return {"status": "ok", "ai": True, "organic": organic, "body": answer.text() or None, "cited": uniq}


def observe(row, parsed, engine, domain, aliases):
    obs = {"qid": row["qid"], "query": row["query"], "engine": engine, "status": parsed["status"],
           "target_url": row.get("target_url")}
    if parsed["status"] != "ok":
        obs.update({"ai_answer_present": None, "sources_status": "unknown", "cited_urls": [],
                    "project_domain_cited": None, "target_url_cited": None, "brand_mentioned": None,
                    "organic_top10": [], "project_best_rank": None, "top10": None, "top3": None,
                    "detail": parsed.get("detail")})
        return obs
    ranks = [i + 1 for i, u in enumerate(parsed["organic"]) if is_own(u, domain)]
    best = min(ranks) if ranks else None
    obs.update({"organic_top10": parsed["organic"], "project_best_rank": best,
                "top10": best is not None, "top3": best is not None and best <= 3,
                "ai_answer_present": parsed["ai"], "cited_urls": parsed["cited"]})
    if not parsed["ai"]:
        obs.update({"sources_status": "none", "project_domain_cited": False, "target_url_cited": False,
                    "brand_mentioned": False})
        return obs
    known = bool(parsed["cited"])
    obs["sources_status"] = "ok" if known else "missing"
    obs["project_domain_cited"] = any(is_own(u, domain) for u in parsed["cited"]) if known else None
    tgt = row.get("target_url")
    obs["target_url_cited"] = (any(same_page(u, tgt) for u in parsed["cited"]) if known else None) if tgt else None
    body = parsed["body"]
    if body is None:
        obs["brand_mentioned"] = None
    else:
        low = body.lower().replace("ё", "е")
        obs["brand_mentioned"] = any(a.lower().replace("ё", "е") in low for a in aliases if a)
    return obs


def credentials(provider):
    if provider == "xmlstock":
        user, key = os.environ.get("XMLSTOCK_USER"), os.environ.get("XMLSTOCK_KEY")
    else:
        user, key = os.environ.get("XMLRIVER_USER"), os.environ.get("XMLRIVER_KEY")
        if key and ":" in key and not user:
            user, key = key.split(":", 1)
    if not user or not key:
        names = "XMLSTOCK_USER/XMLSTOCK_KEY" if provider == "xmlstock" else "XMLRIVER_USER/XMLRIVER_KEY"
        fail("missing_credentials", "set %s in the environment" % names, 2)
    return user, key


def fetch_live(provider, engine, query, region, timeout):
    user, key = credentials(provider)
    params = {"user": user, "key": key, "query": query, "ai": "1"}
    if region:
        params["lr" if engine == "yandex" else "loc"] = region
    url = ENDPOINTS[(provider, engine)] + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "lane-pilot-scripts/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as exc:
        return '<r><error code="network">%s</error></r>' % html.escape(str(exc).replace(key, "***"))


def compute(data, args):
    engine = (args.engine or data.get("engine") or "google").lower()
    provider = (args.provider or data.get("provider") or "xmlriver").lower()
    if (provider, engine) not in ENDPOINTS:
        raise ValueError("unsupported provider/engine: %s/%s" % (provider, engine))
    domain = host_of(data["domain"])
    aliases = list(data.get("aliases") or [])
    panel = data["panel"]
    if args.max_queries:
        panel = panel[:args.max_queries]
    raw = data.get("raw")
    cost = {"requests": len(panel), "rub_per_1000": RUB_PER_1000_AI,
            "estimate_rub": round(len(panel) * RUB_PER_1000_AI / 1000, 2)}
    if raw is None and not args.go:
        return {"mode": "plan", "engine": engine, "provider": provider, "observations": [], "cost": cost,
                "totals": {"planned": len(panel)}, "spent": False,
                "next": "re-run with --go to collect (paid), or add saved responses under \"raw\""}
    mode = "offline" if raw is not None else "live"
    if mode == "live" and args.fixture:
        raise ValueError("--fixture never calls the network")
    observations = []
    for row in panel:
        xml_text = raw.get(row["qid"]) if raw is not None else fetch_live(
            provider, engine, row["query"], data.get("region"), args.timeout)
        parsed = {"status": "missing_raw"} if xml_text is None else parse(xml_text, engine)
        observations.append(observe(row, parsed, engine, domain, aliases))
    ok = [o for o in observations if o["status"] == "ok"]
    totals = {"queries": len(observations), "ok": len(ok), "errors": len(observations) - len(ok),
              "ai_answers": sum(1 for o in ok if o["ai_answer_present"]),
              "sources_missing": sum(1 for o in ok if o["sources_status"] == "missing"),
              "domain_cited": sum(1 for o in ok if o["project_domain_cited"])}
    return {"mode": mode, "engine": engine, "provider": provider, "run": data.get("run"),
            "observations": observations, "totals": totals, "cost": cost, "spent": mode == "live"}


def main():
    ap = Parser(prog=NAME, description="Collect AI answer + organic top-10 per panel query (XMLRiver/XMLStock).")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="parse built-in XML samples offline")
    ap.add_argument("--go", action="store_true", help="spend: live paid requests (env credentials)")
    ap.add_argument("--engine", choices=["google", "yandex"])
    ap.add_argument("--provider", choices=["xmlriver", "xmlstock"])
    ap.add_argument("--max-queries", type=int, help="cap on queries for this run")
    ap.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout, seconds")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
