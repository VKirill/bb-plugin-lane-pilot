#!/usr/bin/env python3
"""UTM validator: tagging taxonomy for end-to-end analytics (UTM links and Telegram start= deep links).

Distilled from the Osipenkov course (UTM taxonomy, macros of Yandex Direct, Client ID joins) and the
Telegram start-parameter rules. Per URL:
  errors   missing utm_source / utm_medium / utm_campaign, empty value, duplicate parameter,
           raw spaces or non-ASCII in a value, hardcoded click id (gclid / yclid / fbclid / ysclid),
           unknown macro, http (not https), invalid t.me start/startapp payload ([A-Za-z0-9_-]{1,64});
  warnings uppercase letters (GA4/Metrika split «CPC» and «cpc»), medium outside the taxonomy,
           utm_content / utm_term missing on paid traffic.

Input JSON: {"urls": [..], "rules": {"allowed_medium": [..], "require": [..], "allow_macros": true,
             "paid_medium": ["cpc", "cpm"]}}
Output JSON: results[] {url, ok, errors[], warnings[], params{}}, summary{}, verdict (pass|fail).
"""
import argparse
import json
import re
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

NAME = "utm_validator.py"
VERSION = "1.0.0"
DEFAULT_MEDIUM = ["cpc", "cpm", "cpa", "social", "paid_social", "email", "referral", "affiliate", "display",
                  "messenger", "tg_ads", "push", "sms", "organic_social", "video", "influencer", "qr"]
REQUIRED = ["utm_source", "utm_medium", "utm_campaign"]
CLICK_IDS = {"gclid", "yclid", "fbclid", "ysclid", "msclkid", "ttclid"}
MACROS = {"{campaign_id}", "{campaign_name}", "{ad_id}", "{banner_id}", "{gbid}", "{phrase_id}", "{keyword}",
          "{source}", "{source_type}", "{position_type}", "{position}", "{device_type}", "{region_id}",
          "{region_name}", "{retargeting_id}", "{coef_goal_context_id}", "{addphrases}", "{campaignid}",
          "{adgroupid}", "{creative}", "{matchtype}", "{network}", "{device}", "{placement}",
          "{{campaign.id}}", "{{ad.id}}", "{{adset.id}}"}
START_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


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


FIXTURE = {"urls": [
    "https://shop.ru/sofas/?utm_source=yandex&utm_medium=cpc&utm_campaign={campaign_id}&utm_content={ad_id}&utm_term={keyword}",
    "https://shop.ru/sofas/?utm_source=VK&utm_medium=Paid Social&utm_campaign=autumn",
    "http://shop.ru/?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=Cj0KCQ123",
    "https://shop.ru/?utm_source=telegram&utm_medium=tg_ads&utm_campaign=осень&utm_campaign=autumn",
    "https://t.me/shop_bot?start=tgads_c12_a3",
    "https://t.me/shop_bot?start=bad payload!",
    "https://shop.ru/?utm_source=yandex&utm_medium=cpc&utm_campaign=x&utm_content={unknown_macro}",
]}


def check(url, rules):
    errors, warnings = [], []
    p = urlsplit(url.strip())
    pairs = parse_qsl(p.query, keep_blank_values=True)
    params = {}
    for k, v in pairs:
        if k in params:
            errors.append("duplicate parameter %s" % k)
        params[k] = v
    host = (p.hostname or "").lower()
    if host in ("t.me", "telegram.me"):
        for key in ("start", "startapp", "startgroup"):
            if key in params:
                if not START_RE.match(params[key]):
                    errors.append("%s payload %r must match [A-Za-z0-9_-]{1,64}" % (key, params[key]))
        if not any(k in params for k in ("start", "startapp", "startgroup")):
            warnings.append("t.me link without start payload: bot traffic cannot be attributed")
        return errors, warnings, params
    if p.scheme != "https":
        errors.append("scheme %s: use https (http drops referrer and may break redirects)" % (p.scheme or "none"))
    for k in rules["require"]:
        if k not in params:
            errors.append("missing %s" % k)
        elif not params[k].strip():
            errors.append("empty %s" % k)
    for k, v in pairs:
        if k.lower() in CLICK_IDS:
            errors.append("hardcoded click id %s: the ad platform adds it per click" % k)
        if not k.startswith("utm_"):
            continue
        raw = unquote(v)
        for m in re.findall(r"\{\{?[^{}]+\}?\}", raw):
            if not rules["allow_macros"]:
                errors.append("macro %s not allowed" % m)
            elif m not in MACROS:
                errors.append("unknown macro %s in %s" % (m, k))
        plain = re.sub(r"\{\{?[^{}]+\}?\}", "", raw)
        if " " in plain:
            errors.append("space in %s=%r: use _ or -" % (k, raw))
        if any(ord(ch) > 127 for ch in plain):
            errors.append("non-ASCII in %s=%r: transliterate" % (k, raw))
        if plain != plain.lower():
            warnings.append("uppercase in %s=%r: reports split by case" % (k, raw))
    med = params.get("utm_medium", "").lower()
    if med and med not in rules["allowed_medium"]:
        warnings.append("utm_medium %r outside taxonomy" % params.get("utm_medium"))
    if med in rules["paid_medium"]:
        for k in ("utm_content", "utm_term"):
            if k not in params:
                warnings.append("%s missing on paid traffic: ad/keyword level is lost" % k)
    return errors, warnings, params


def compute(data, args):
    r = data.get("rules") or {}
    rules = {"allowed_medium": [x.lower() for x in r.get("allowed_medium") or DEFAULT_MEDIUM],
             "require": r.get("require") or REQUIRED, "allow_macros": r.get("allow_macros", True),
             "paid_medium": [x.lower() for x in r.get("paid_medium") or ["cpc", "cpm", "cpa", "tg_ads", "paid_social"]]}
    urls = data["urls"]
    if not urls:
        raise ValueError("urls is empty")
    results = []
    for u in urls:
        e, w, params = check(str(u), rules)
        results.append({"url": u, "ok": not e, "errors": e, "warnings": w, "params": params})
    bad = sum(1 for x in results if not x["ok"])
    return {"results": results, "summary": {"urls": len(results), "failed": bad,
                                            "warnings": sum(len(x["warnings"]) for x in results)},
            "verdict": "fail" if bad else "pass"}


def main():
    ap = Parser(prog=NAME, description="Validate UTM tagging and Telegram start= deep links.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--strict", action="store_true", help="exit 3 when any URL fails")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "fail":
        sys.exit(3)


if __name__ == "__main__":
    main()
