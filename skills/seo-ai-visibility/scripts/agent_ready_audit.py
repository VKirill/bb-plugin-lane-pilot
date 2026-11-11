#!/usr/bin/env python3
"""Agent Ready audit: 19 checks that decide whether AI agents and answer engines can read the site.

Distilled from the GEO/AEO canon (DrMax + Paraev + Kotenkov + SEOhowto «Agent Ready» checklist):
robots.txt access for AI crawlers, Content Signals, llms.txt, sitemap, server-rendered text,
meta/canonical/noindex hygiene, Organization JSON-LD and Open Graph.

Modes:
  --fixture              built-in sample, offline
  --input F              offline: {"base_url", "status", "headers", "home_html", "robots_txt",
                                   "llms_txt", "sitemap_xml"}  (null = not found)
  --url https://site.ru  live: fetches /, /robots.txt, /llms.txt and the sitemap (read-only GET)
Output JSON: checks[] {id, name, pass, severity, detail}, passed, total, score, failed_critical[].
"""
import argparse
from html.parser import HTMLParser
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

NAME = "agent_ready_audit.py"
VERSION = "1.0.0"
AI_BOTS = ("GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended",
           "YandexBot", "Bingbot")
ORG_TYPES = {"Organization", "LocalBusiness", "Corporation", "ProfessionalService"}


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
    if args.url:
        return None
    if not args.input:
        fail("no_input", "pass --input FILE.json, --url URL or --fixture", 2)
    try:
        if args.input == "-":
            return json.load(sys.stdin)
        with open(args.input, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        fail("bad_input", "%s: %s" % (args.input, exc), 2)


FIXTURE = {
    "base_url": "https://example-agency.ru/", "status": 200, "headers": {"content-type": "text/html"},
    "robots_txt": "User-agent: *\nAllow: /\nContent-Signal: search=yes, ai-input=yes, ai-train=no\n\n"
                  "User-agent: GPTBot\nDisallow: /\n\nSitemap: https://example-agency.ru/sitemap.xml\n",
    "llms_txt": "# Example Agency\n\n> SEO and GEO agency in Moscow.\n\n## Services\n- [SEO](https://example-agency.ru/seo/): audits and growth\n",
    "sitemap_xml": '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                   "<url><loc>https://example-agency.ru/</loc></url></urlset>",
    "home_html": '<!doctype html><html lang="ru"><head><title>Example Agency — SEO и GEO продвижение в Москве</title>'
                 '<meta name="description" content="Продвижение сайтов в поиске и ответах ИИ: аудит, стратегия, контент. Работаем с 2015 года.">'
                 '<link rel="canonical" href="https://example-agency.ru/">'
                 '<meta property="og:title" content="Example Agency"><meta property="og:description" content="SEO и GEO">'
                 '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Example Agency"}</script>'
                 "</head><body><h1>SEO и GEO продвижение</h1><p>" + "Мы помогаем сайтам расти в поиске. " * 20 +
                 "</p></body></html>",
}


def fetch(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "lane-pilot-scripts/1.0 (agent-ready-audit)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read(3_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in exc.headers.items()}, None
    except (urllib.error.URLError, OSError) as exc:
        return None, {"error": str(exc)}, None


def collect_live(url, timeout):
    base = url if url.endswith("/") else url + "/"
    status, headers, home = fetch(base, timeout)
    if status is None:
        fail("network", "cannot fetch %s: %s" % (base, headers.get("error")), 1)
    rs, _, robots = fetch(urllib.parse.urljoin(base, "/robots.txt"), timeout)
    ls, _, llms = fetch(urllib.parse.urljoin(base, "/llms.txt"), timeout)
    sm_url = None
    for line in (robots or "").splitlines():
        if line.lower().startswith("sitemap:"):
            sm_url = line.split(":", 1)[1].strip()
            break
    ss, _, sitemap = fetch(sm_url or urllib.parse.urljoin(base, "/sitemap.xml"), timeout)
    return {"base_url": base, "status": status, "headers": headers, "home_html": home,
            "robots_txt": robots if rs == 200 else None, "llms_txt": llms if ls == 200 else None,
            "sitemap_xml": sitemap if ss == 200 else None}


def robots_groups(text):
    groups, agents, rules, last_rule = [], [], [], False
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        k, v = [x.strip() for x in line.split(":", 1)]
        k = k.lower()
        if k == "user-agent":
            if last_rule:
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(v.lower())
            last_rule = False
        elif k in ("allow", "disallow"):
            rules.append((k, v))
            last_rule = True
    if agents:
        groups.append((agents, rules))
    return groups


def blocks_root(text, bot):
    groups = robots_groups(text)
    chosen = [r for a, r in groups if bot.lower() in a] or [r for a, r in groups if "*" in a]
    for rules in chosen:
        dis = any(k == "disallow" and v == "/" for k, v in rules)
        allow = any(k == "allow" and v == "/" for k, v in rules)
        if dis and not allow:
            return True
    return False


class Page(HTMLParser):
    """Stdlib HTML parser: title, meta, links, h1 count, html lang, JSON-LD blocks and visible text."""

    SKIP = {"script", "style", "noscript", "template"}

    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.title, self.metas, self.links, self.h1, self.lang = "", {}, [], 0, None
        self.jsonld, self.text, self._stack, self._ld = [], [], [], None
        self.feed(text or "")
        self.close()

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        self._stack.append(tag)
        if tag == "html":
            self.lang = a.get("lang") or None
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key:
                self.metas[key] = a.get("content", "").strip()
        elif tag == "link":
            self.links.append(a)
        elif tag == "h1":
            self.h1 += 1
        elif tag == "script" and a.get("type", "").lower() == "application/ld+json":
            self._ld = []

    def handle_endtag(self, tag):
        if tag == "script" and self._ld is not None:
            self.jsonld.append("".join(self._ld))
            self._ld = None
        if tag in self._stack:
            while self._stack and self._stack.pop() != tag:
                continue

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
        elif self._stack and self._stack[-1] == "title":
            self.title += data
        elif not (set(self._stack) & self.SKIP):
            self.text.append(data)

    def visible_text(self):
        return " ".join(" ".join(self.text).split())

    def has_rel(self, rel):
        return any(rel in l.get("rel", "").lower().split() for l in self.links)

    def jsonld_types(self):
        types = set()

        def walk(node):
            if isinstance(node, dict):
                t = node.get("@type")
                types.update(t if isinstance(t, list) else [t] if t else [])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        for block in self.jsonld:
            try:
                walk(json.loads(block))
            except ValueError:
                types.add("<invalid-json-ld>")
        return types


def sitemap_ok(text):
    if not text:
        return False
    try:
        root = ET.fromstring(text.encode("utf-8"))
    except ET.ParseError:
        return False
    return root.tag.rsplit("}", 1)[-1] in ("urlset", "sitemapindex")


def audit(d):
    base = d.get("base_url") or ""
    home = d.get("home_html") or ""
    robots, llms, sitemap = d.get("robots_txt"), d.get("llms_txt"), d.get("sitemap_xml")
    headers = {k.lower(): str(v) for k, v in (d.get("headers") or {}).items()}
    page = Page(home)
    title = page.title.strip()
    desc = page.metas.get("description")
    robots_meta = page.metas.get("robots", "") + " " + headers.get("x-robots-tag", "")
    blocked = [b for b in AI_BOTS if robots and blocks_root(robots, b)]
    types = page.jsonld_types()
    text_len = len(page.visible_text())
    h1 = page.h1
    c = []

    def add(cid, name, ok, severity, detail):
        c.append({"id": cid, "name": name, "pass": bool(ok), "severity": severity, "detail": detail})

    add(1, "https", base.startswith("https://"), "critical", base)
    add(2, "home_status_200", d.get("status") == 200, "critical", "status=%s" % d.get("status"))
    add(3, "robots_txt_present", robots is not None, "major", "robots.txt %s" % ("found" if robots is not None else "missing"))
    add(4, "robots_not_disallow_all", not (robots and blocks_root(robots, "*")), "critical", "User-agent: * Disallow: /")
    add(5, "ai_bots_allowed", not blocked, "major", "blocked: %s" % (", ".join(blocked) or "none"))
    add(6, "content_signals_declared", bool(robots and re.search(r"(?im)^\s*content-signal\s*:", robots)), "minor",
        "Content-Signal line in robots.txt")
    add(7, "sitemap_declared", bool(robots and re.search(r"(?im)^\s*sitemap\s*:", robots)), "minor", "Sitemap: in robots.txt")
    add(8, "sitemap_valid", sitemap_ok(sitemap), "major", "urlset/sitemapindex root")
    add(9, "llms_txt_present", llms is not None, "minor", "/llms.txt %s" % ("found" if llms is not None else "missing"))
    add(10, "llms_txt_structure", bool(llms and re.match(r"\s*# \S", llms) and re.search(r"\[[^\]]+\]\(https?://", llms)),
        "minor", "H1 title and markdown links")
    add(11, "title_length", 10 <= len(title) <= 70, "major", "%d chars" % len(title))
    add(12, "meta_description", desc is not None and 50 <= len(desc) <= 170, "minor", "%s chars" % (len(desc) if desc is not None else "none"))
    add(13, "canonical_present", page.has_rel("canonical"), "major", "link rel=canonical")
    add(14, "no_noindex", "noindex" not in robots_meta.lower(), "critical", robots_meta.strip() or "no robots meta")
    add(15, "html_lang", bool(page.lang), "minor", "html lang attribute")
    add(16, "jsonld_organization", bool(types & ORG_TYPES),
        "major", "Organization-type JSON-LD")
    add(17, "server_rendered_text", text_len >= 500, "critical", "%d visible chars without JS" % text_len)
    add(18, "single_h1", h1 == 1, "minor", "%d h1" % h1)
    add(19, "open_graph", "og:title" in page.metas and "og:description" in page.metas, "minor", "og:title + og:description")
    passed = sum(1 for x in c if x["pass"])
    return {"base_url": base, "checks": c, "passed": passed, "total": len(c), "score": round(passed / len(c), 4),
            "failed_critical": [x["name"] for x in c if not x["pass"] and x["severity"] == "critical"],
            "verdict": "fail" if any(not x["pass"] and x["severity"] == "critical" for x in c) else "pass"}


def main():
    ap = Parser(prog=NAME, description="Agent Ready audit: 19 checks for AI crawlers and answer engines.")
    ap.add_argument("--input", help="JSON snapshot of the site, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--url", help="live mode: site root URL (read-only GET requests)")
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--strict", action="store_true", help="exit 3 when a critical check fails")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    if data is None:
        data = collect_live(args.url, args.timeout)
    try:
        result = audit(data)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "fail":
        sys.exit(3)


if __name__ == "__main__":
    main()
