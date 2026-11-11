#!/usr/bin/env python3
"""SEO pulse probe: is the site up, is it closed in robots.txt, did key pages lose index signals.

Distilled from the Kotenkov 4.6 lesson (pulse_probe). Rules:
  * positive control first: if the monitor itself has no network, the check is BLIND (no verdict);
  * a page is DOWN only after 2 failed checks in a row (no response / 5xx); 4xx or an endless
    redirect two checks in a row is «responds 404»; one network blip is never an alert;
  * an anti-bot challenge (403/429/503 with a protection signature) is NOT down — the site answers;
  * robots.txt with Disallow: / for Googlebot/YandexBot/* is critical;
  * --watch: noindex (meta or X-Robots-Tag), canonical drift and empty title on key pages.

Modes:
  --fixture                    built-in sample, offline
  --input F                    offline snapshot: {"control_ok", "robots_txt", "watch",
                               "checks": [{"url", "kind", "status", "headers", "body", "prev_fail",
                                           "expect_canonical"}]}
  --url U [--url U2] [--state F]   live GET checks; --state keeps consecutive failures between runs
Output JSON: blind, conditions[] {key, level, message}, pages[], robots{}, verdict.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

NAME = "pulse_probe.py"
VERSION = "1.0.0"
CONTROL_URLS = ("https://ya.ru/", "https://www.google.com/generate_204")
ANTIBOT = ("cf-chl", "captcha", "ddos-guard", "checking your browser", "servicepipe", "qrator", "just a moment")
BOTS = ("googlebot", "yandex", "*")


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
    "control_ok": True, "watch": True,
    "robots_txt": "User-agent: *\nDisallow: /admin/\n\nUser-agent: Yandex\nDisallow: /\n",
    "checks": [
        {"url": "https://example.ru/", "kind": "home", "status": 200, "headers": {},
         "body": '<html><head><title>Example</title><link rel="canonical" href="https://example.ru/"></head></html>',
         "prev_fail": 0, "expect_canonical": "https://example.ru/"},
        {"url": "https://example.ru/pricing/", "kind": "money", "status": 503, "headers": {}, "body": "",
         "prev_fail": 1},
        {"url": "https://example.ru/catalog/", "kind": "money", "status": 403, "headers": {},
         "body": "<html><title>Just a moment...</title><div id='cf-chl-widget'></div></html>", "prev_fail": 0},
        {"url": "https://example.ru/blog/guide/", "kind": "money", "status": 200,
         "headers": {"X-Robots-Tag": "noindex"}, "prev_fail": 0,
         "body": '<html><head><title></title><link rel="canonical" href="https://example.ru/blog/"></head></html>',
         "expect_canonical": "https://example.ru/blog/guide/"},
    ],
}


class Head(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.title, self.robots, self.canonical, self._in_title = None, "", None, False
        self.feed(text or "")
        self.close()

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title, self.title = True, self.title or ""
        elif tag == "meta" and a.get("name", "").lower() in ("robots", "googlebot", "yandex"):
            self.robots += " " + a.get("content", "").lower()
        elif tag == "link" and "canonical" in a.get("rel", "").lower().split():
            self.canonical = a.get("href")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def fetch(url, timeout, body=True):
    req = urllib.request.Request(url, headers={"User-Agent": "lane-pilot-scripts/1.0 (pulse-probe)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"status": resp.status, "headers": dict(resp.headers.items()),
                    "body": resp.read(1_000_000).decode("utf-8", "replace") if body else ""}
    except urllib.error.HTTPError as exc:
        return {"status": exc.code, "headers": dict(exc.headers.items()), "body": exc.read(200_000).decode("utf-8", "replace")}
    except (urllib.error.URLError, OSError) as exc:
        return {"status": None, "headers": {}, "body": "", "error": str(exc)}


def robots_blocks_all(text, bot):
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
    mine = [r for a, r in groups if any(bot != "*" and x.startswith(bot) for x in a)]
    chosen = mine or [r for a, r in groups if "*" in a]
    return any(any(k == "disallow" and v == "/" for k, v in r) and not any(k == "allow" and v == "/" for k, v in r)
               for r in chosen)


def classify(check):
    status, body = check.get("status"), (check.get("body") or "").lower()
    if status is None or (isinstance(status, int) and status >= 500 and not any(s in body for s in ANTIBOT)):
        return "fail_down"
    if status in (403, 429, 503) and any(s in body for s in ANTIBOT):
        return "antibot"
    if status >= 400 or 300 <= status < 400:
        return "fail_client"
    return "up"


def compute(data, args, state):
    if not data.get("control_ok", True):
        return {"blind": True, "verdict": "blind", "conditions": [], "pages": [], "robots": {},
                "reason": "monitor has no network: control URLs failed, nothing is decided about the site"}
    watch = bool(args.watch or data.get("watch"))
    conds, pages = [], []
    for c in data["checks"]:
        url = c["url"]
        state_kind = classify(c)
        prev = int(c.get("prev_fail", state.get(url, 0)))
        streak = prev + 1 if state_kind.startswith("fail") else 0
        state[url] = streak
        page = {"url": url, "kind": c.get("kind", "money"), "status": c.get("status"), "state": state_kind,
                "fail_streak": streak}
        if state_kind == "fail_down" and streak >= 2:
            conds.append({"key": "down:" + url, "level": "critical", "message": "no response / 5xx two checks in a row"})
        elif state_kind == "fail_client" and streak >= 2:
            conds.append({"key": "http:" + url, "level": "critical",
                          "message": "responds %s two checks in a row" % c.get("status")})
        if watch and state_kind == "up" and c.get("body"):
            head = Head(c["body"])
            xrt = " ".join(str(v).lower() for k, v in (c.get("headers") or {}).items() if k.lower() == "x-robots-tag")
            if "noindex" in head.robots + " " + xrt:
                conds.append({"key": "noindex:" + url, "level": "critical", "message": "noindex on a key page"})
            exp = c.get("expect_canonical")
            if exp and head.canonical and head.canonical.rstrip("/") != exp.rstrip("/"):
                conds.append({"key": "canonical:" + url, "level": "warning",
                              "message": "canonical %s != expected %s" % (head.canonical, exp)})
            if head.title is not None and not head.title.strip():
                conds.append({"key": "title:" + url, "level": "warning", "message": "empty <title>"})
            page.update({"canonical": head.canonical, "title": (head.title or "").strip() or None})
        pages.append(page)
    robots_txt = data.get("robots_txt")
    robots = {"present": robots_txt is not None, "blocked_bots": [b for b in BOTS if robots_txt and robots_blocks_all(robots_txt, b)]}
    for b in robots["blocked_bots"]:
        conds.append({"key": "robots:" + b, "level": "critical", "message": "robots.txt disallows / for %s" % b})
    verdict = "critical" if any(x["level"] == "critical" for x in conds) else ("warning" if conds else "ok")
    return {"blind": False, "watch": watch, "conditions": sorted(conds, key=lambda x: x["key"]), "pages": pages,
            "robots": robots, "verdict": verdict}


def live_snapshot(args):
    control_ok = any(fetch(u, 15, body=False).get("status") for u in CONTROL_URLS)
    checks = []
    for i, u in enumerate(args.url):
        r = fetch(u, args.timeout)
        checks.append({"url": u, "kind": "home" if i == 0 else "money", "status": r["status"],
                       "headers": r["headers"], "body": r["body"]})
    root = urllib.parse.urljoin(args.url[0], "/robots.txt")
    rr = fetch(root, args.timeout)
    return {"control_ok": control_ok, "checks": checks, "robots_txt": rr["body"] if rr["status"] == 200 else None}


def main():
    ap = Parser(prog=NAME, description="Availability, robots.txt and index-signal probe for key pages.")
    ap.add_argument("--input", help="JSON snapshot, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--url", action="append", help="live mode: page URL (first = home); repeatable")
    ap.add_argument("--state", help="JSON file with consecutive-failure counters (live mode)")
    ap.add_argument("--watch", action="store_true", help="also check noindex, canonical and title")
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--strict", action="store_true", help="exit 3 when verdict is critical")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    state = {}
    if args.state and not args.fixture:
        try:
            with open(args.state, encoding="utf-8") as fh:
                state = json.load(fh)
        except FileNotFoundError:
            state = {}
        except (OSError, ValueError) as exc:
            fail("bad_state", "%s: %s" % (args.state, exc), 2)
    if data is None:
        data = live_snapshot(args)
    try:
        result = compute(data, args, state)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    if args.state and not args.fixture:
        try:
            with open(args.state, "w", encoding="utf-8") as fh:
                json.dump(state, fh, sort_keys=True)
        except OSError as exc:
            fail("state_write", "%s: %s" % (args.state, exc), 1)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "critical":
        sys.exit(3)


if __name__ == "__main__":
    main()
