#!/usr/bin/env python3
"""CRO speed signals: first-screen and render-speed signals of a landing page, from HTML (+ optional field data).

Distilled from the mkt-landing-cro method (5-second offer clarity test, Message Match ad <-> first
screen, render speed, micro-conversions, proof from BrandCore). Static checks with the stdlib HTML
parser — no browser:
  render   blocking scripts in <head> (no async/defer/module), stylesheet count, HTML weight,
           inline script weight, third-party hosts, images without width/height (CLS), lazy-loaded
           first image (LCP anti-pattern), missing viewport meta, font preload;
  offer    exactly one H1, H1 words that match the ad promise (message match), CTA elements in the
           first screen proxy (first 20% of body text), form fields count, tel: link, proof signals
           (reviews, ratings, clients, years, numbers);
  field    optional CrUX/PSI p75 values: LCP <= 2500 ms, INP <= 200 ms, CLS <= 0.1 (good) /
           LCP > 4000, INP > 500, CLS > 0.25 (poor).

Modes: --fixture | --input F {"url", "html", "ad_promise", "field": {"lcp_ms", "inp_ms", "cls"}} |
       --url U (live GET, also measures time to first byte)
Output JSON: signals{}, field{}, issues[] {id, severity, detail}, score (0-100).
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urlsplit

NAME = "cro_speed_signals.py"
VERSION = "1.0.0"
CTA_WORDS = ("купить", "заказать", "оформить", "записаться", "получить", "оставить заявку", "рассчитать", "попробовать",
             "подобрать", "позвонить", "buy", "order", "get started", "sign up", "try", "book", "start")
PROOF_WORDS = ("отзыв", "клиент", "рейтинг", "★", "лет на рынке", "гарантия", "кейс", "сертифик", "reviews", "rating", "clients")
FIELD = {"lcp_ms": (2500, 4000), "inp_ms": (200, 500), "cls": (0.1, 0.25)}


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
    "url": "https://divan-shop.ru/uglovye/", "ad_promise": "Угловые диваны на заказ за 14 дней",
    "field": {"lcp_ms": 3900, "inp_ms": 180, "cls": 0.21},
    "html": ('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Угловые диваны</title>'
             '<link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="https://fonts.example.com/css">'
             '<script src="https://widgets.example-chat.com/w.js"></script><script src="/js/app.js" defer></script>'
             '</head><body><header><a href="tel:+74950000000">+7 495 000-00-00</a></header>'
             '<h1>Угловые диваны от фабрики</h1><img src="/hero.jpg" loading="lazy">'
             '<p>Изготовим за 14 дней, 120 тканей, рассрочка 0%.</p><a class="btn" href="#form">Рассчитать стоимость</a>'
             + "<p>Каталог моделей и размеров.</p>" * 30 +
             '<section><h2>Отзывы клиентов</h2><p>4,9 ★ из 1200 отзывов</p></section>'
             '<form id="form"><input name="name"><input name="phone"><input name="email"><input name="city">'
             '<input name="size"><button>Отправить</button></form><img src="/a.jpg" width="300" height="200"></body></html>'),
}


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.in_head, self.blocking, self.styles, self.scripts_inline = False, [], 0, 0
        self.srcs, self.imgs, self.h1, self.h1_text, self.inputs, self.tel = [], [], 0, [], 0, False
        self.viewport, self.font_preload, self.text, self._h1, self._script = False, False, [], False, False
        self.cta_pos = []
        self.feed(text or "")
        self.close()

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "head":
            self.in_head = True
        elif tag == "body":
            self.in_head = False
        elif tag == "script":
            self._script = True
            if a.get("src"):
                self.srcs.append(a["src"])
                if self.in_head and "async" not in a and "defer" not in a and a.get("type") != "module":
                    self.blocking.append(a["src"])
        elif tag == "link":
            rel = a.get("rel", "").lower().split()
            if "stylesheet" in rel:
                self.styles += 1
                self.srcs.append(a.get("href", ""))
            if "preload" in rel and a.get("as") == "font":
                self.font_preload = True
        elif tag == "meta" and a.get("name", "").lower() == "viewport":
            self.viewport = True
        elif tag == "img":
            self.imgs.append(a)
            self.srcs.append(a.get("src", ""))
        elif tag == "h1":
            self.h1 += 1
            self._h1 = True
        elif tag in ("input", "select", "textarea") and a.get("type", "").lower() not in ("hidden", "submit"):
            self.inputs += 1
        elif tag == "a" and a.get("href", "").startswith("tel:"):
            self.tel = True

    def handle_endtag(self, tag):
        if tag == "h1":
            self._h1 = False
        elif tag == "script":
            self._script = False
        elif tag == "head":
            self.in_head = False

    def handle_data(self, data):
        if self._script:
            self.scripts_inline += len(data)
            return
        if self.in_head:
            return
        if self._h1:
            self.h1_text.append(data)
        low = data.lower()
        if any(w in low for w in CTA_WORDS):
            self.cta_pos.append(sum(len(t) for t in self.text))
        self.text.append(data)


def stems(s):
    return {t[:5] for t in re.findall(r"[0-9a-zа-яё]+", (s or "").lower().replace("ё", "е")) if len(t) > 2}


def analyze(d):
    html = d.get("html") or ""
    if not html.strip():
        raise ValueError("html is empty")
    page = Page(html)
    host = (urlsplit(d.get("url") or "").hostname or "").lower()
    third = sorted({urlsplit(s).hostname for s in page.srcs if s.startswith("http") and urlsplit(s).hostname
                    and urlsplit(s).hostname != host})
    body_text = " ".join("".join(page.text).split())
    first_screen = max(1, int(len("".join(page.text)) * 0.2))
    cta_first = sum(1 for p in page.cta_pos if p <= first_screen)
    h1 = " ".join("".join(page.h1_text).split())
    promise = d.get("ad_promise")
    match = None
    if promise:
        ps = stems(promise)
        match = round(len(ps & stems(h1)) / len(ps), 3) if ps else None
    first_img = page.imgs[0] if page.imgs else {}
    proof = sorted({w for w in PROOF_WORDS if w in body_text.lower()})
    sig = {"html_bytes": len(html.encode("utf-8")), "blocking_scripts": page.blocking, "stylesheets": page.styles,
           "inline_script_bytes": page.scripts_inline, "third_party_hosts": third,
           "images": len(page.imgs), "images_without_size": sum(1 for i in page.imgs if not (i.get("width") and i.get("height"))),
           "first_image_lazy": first_img.get("loading") == "lazy", "viewport_meta": page.viewport,
           "font_preload": page.font_preload, "h1_count": page.h1, "h1_text": h1, "message_match": match,
           "cta_in_first_screen": cta_first, "form_fields": page.inputs, "tel_link": page.tel, "proof_signals": proof,
           "numbers_in_text": len(re.findall(r"\d+", body_text)), "ttfb_ms": d.get("ttfb_ms")}
    issues = []

    def add(iid, sev, detail):
        issues.append({"id": iid, "severity": sev, "detail": detail})
    if page.blocking:
        add("render_blocking_scripts", "major", "%d blocking <script> in <head>" % len(page.blocking))
    if page.styles > 3:
        add("too_many_stylesheets", "minor", "%d stylesheets" % page.styles)
    if sig["first_image_lazy"]:
        add("lazy_lcp_image", "major", "first image has loading=lazy: delays LCP")
    if sig["images_without_size"]:
        add("images_without_size", "minor", "%d images without width/height: CLS" % sig["images_without_size"])
    if not page.viewport:
        add("no_viewport", "major", "no meta viewport: mobile layout breaks")
    if len(third) > 5:
        add("third_party_heavy", "minor", "%d third-party hosts" % len(third))
    if page.h1 != 1:
        add("h1_count", "major", "%d H1 on the page" % page.h1)
    if match is not None and match < 0.5:
        add("message_mismatch", "major", "only %.0f%% of the ad promise words are in the H1" % (match * 100))
    if cta_first == 0:
        add("no_cta_first_screen", "major", "no CTA in the first screen proxy")
    if page.inputs > 4:
        add("long_form", "minor", "%d form fields (> 4 lowers conversion)" % page.inputs)
    if not proof:
        add("no_proof", "minor", "no reviews / ratings / client proof found")
    if d.get("ttfb_ms") and d["ttfb_ms"] > 800:
        add("slow_ttfb", "major", "TTFB %d ms > 800 ms" % d["ttfb_ms"])
    field = {}
    for k, (good, poor) in FIELD.items():
        v = (d.get("field") or {}).get(k)
        if v is None:
            continue
        rating = "good" if v <= good else ("poor" if v > poor else "needs_improvement")
        field[k] = {"value": v, "rating": rating}
        if rating != "good":
            add("field_" + k, "major" if rating == "poor" else "minor", "%s p75 = %s (%s)" % (k, v, rating))
    penalty = sum(15 if i["severity"] == "major" else 5 for i in issues)
    return {"url": d.get("url"), "signals": sig, "field": field, "issues": issues, "score": max(0, 100 - penalty)}


def live(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "lane-pilot-scripts/1.0 (cro-speed-signals)"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            first = resp.read(1)
            ttfb = int((time.monotonic() - t0) * 1000)
            body = first + resp.read(5_000_000)
    except (urllib.error.URLError, OSError) as exc:
        fail("network", "cannot fetch %s: %s" % (url, exc), 1)
    return {"url": url, "html": body.decode("utf-8", "replace"), "ttfb_ms": ttfb}


def main():
    ap = Parser(prog=NAME, description="Landing first-screen and render-speed signals from HTML (+ field data).")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--url", help="live mode: landing URL (single GET)")
    ap.add_argument("--ad-promise", help="ad headline to check message match against the H1")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    if data is None:
        data = live(args.url, args.timeout)
    if args.ad_promise:
        data["ad_promise"] = args.ad_promise
    try:
        result = analyze(data)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
