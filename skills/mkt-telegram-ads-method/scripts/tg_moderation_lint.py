#!/usr/bin/env python3
"""Telegram Ads moderation lint: catch the usual «Declined» triggers before an ad is submitted.

Rules (from the mkt-telegram-ads-method moderation reference; limits configurable):
  errors   text > 160 chars; line breaks / bullets; CAPS words (except known abbreviations);
           more than 1 emoji; imperative pressure with "!" («Жми срочно!»); superlatives and income /
           cure guarantees («№1», «гарантированный заработок», «300%»); shock / grief wording;
           links or @mentions inside the text; t.me destination without start= payload for a bot;
           destination language differs from the ad language (when both are given);
           missing erid when ad marking is required (RU targeting);
  warnings informal «ты», more than one "!", repeated punctuation («!!», «??», «...»).

Input JSON: {"require_erid": true, "max_len": 160, "max_emoji": 1, "abbreviations": ["CRM", "AI"],
             "ads": [{"ad_id", "text", "lang", "destination", "destination_lang", "erid"}]}
Output JSON: results[] {ad_id, ok, length, errors[], warnings[]}, summary{}, verdict (pass|fail).
"""
import argparse
import json
import re
import sys
from urllib.parse import parse_qs, urlsplit

NAME = "tg_moderation_lint.py"
VERSION = "1.0.0"
ABBR = {"CRM", "AI", "B2B", "B2C", "SEO", "SMM", "IT", "PDF", "API", "SaaS", "HR", "UX", "UI", "VPN", "USD", "EUR",
        "TON", "ИИ", "РФ", "ОАЭ", "МСК", "СПБ", "НДС", "ИП", "ООО"}
PRESSURE = ["жми", "кликай", "купи", "успей", "срочно", "только сегодня", "переходи", "подпишись", "скорее"]
SUPERLATIVE = ["самый лучший", "лучший сервис", "№1", "номер один", "гарантированный заработок", "гарантируем доход",
               "без вложений", "пассивный доход", "вылечит", "исцел", "100% результат", "300%", "x10 к доходу"]
SHOCK = ["смерть", "умер", "трагед", "траур", "шок", "ужас", "до/после", "до и после"]
EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\U00002B00-\U00002BFF]")


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


FIXTURE = {"require_erid": True, "ads": [
    {"ad_id": "a1", "lang": "ru", "destination_lang": "ru", "erid": "2Vtzqx7Qm1",
     "text": "Оживите архивное семейное фото за минуту: бот раскрасит снимок и уберёт царапины. Попробуйте бесплатно в боте.",
     "destination": "https://t.me/photo_revive_bot?start=c12_a1"},
    {"ad_id": "a2", "lang": "ru", "destination_lang": "en", "erid": "",
     "text": "ЖМИ СРОЧНО! Самый лучший сервис №1 🔥🔥 Ты теряешь деньги!!",
     "destination": "https://t.me/photo_revive_bot"},
    {"ad_id": "a3", "lang": "ru", "erid": "2Vtzqx7Qm3",
     "text": "Разбор CRM для отдела продаж:\n- воронка\n- скрипты. Подробнее на site.ru и у @sales_guru",
     "destination": "https://t.me/sales_channel"},
]}


def lint(ad, cfg):
    text = str(ad.get("text") or "")
    low = text.lower().replace("ё", "е")
    errors, warnings = [], []
    if not text.strip():
        errors.append("empty text")
    if len(text) > cfg["max_len"]:
        errors.append("text %d chars > %d" % (len(text), cfg["max_len"]))
    if "\n" in text or re.search(r"(^|\s)[-•·*]\s", text):
        errors.append("line breaks or bullets: one plain line only")
    caps = [w for w in re.findall(r"[A-Za-zА-Яа-яЁё]{3,}", text) if w.isupper() and w not in cfg["abbr"]]
    if caps:
        errors.append("CAPS words: %s" % ", ".join(sorted(set(caps))))
    emoji = EMOJI_RE.findall(text)
    if len(emoji) > cfg["max_emoji"]:
        errors.append("%d emoji > %d" % (len(emoji), cfg["max_emoji"]))
    if "!" in text and any(re.search(r"(^|[^а-яa-z])%s" % re.escape(p), low) for p in PRESSURE):
        errors.append("imperative pressure with '!'")
    for p in SUPERLATIVE:
        if p in low:
            errors.append("superlative / guarantee: %s" % p)
    for p in SHOCK:
        if p in low:
            errors.append("shock / grief wording: %s" % p)
    if re.search(r"https?://|www\.|\b[a-z0-9-]+\.(ru|com|io|net|org|me)\b|@[A-Za-z0-9_]{4,}", text, re.I):
        errors.append("link or @mention inside the ad text")
    dest = str(ad.get("destination") or "")
    if dest:
        u = urlsplit(dest)
        if u.hostname in ("t.me", "telegram.me") and u.path.strip("/").lower().endswith("bot"):
            payload = (parse_qs(u.query).get("start") or [""])[0]
            if not payload:
                errors.append("bot destination without start= payload: the ad cannot be attributed")
    if ad.get("lang") and ad.get("destination_lang") and ad["lang"] != ad["destination_lang"]:
        errors.append("language mismatch: ad %s, destination %s" % (ad["lang"], ad["destination_lang"]))
    if cfg["require_erid"] and not str(ad.get("erid") or "").strip():
        errors.append("missing erid (ad marking required)")
    if re.search(r"(^|[^а-я])(ты|тебя|тебе|твой|твои)([^а-я]|$)", low):
        warnings.append("informal «ты»: moderation prefers «вы» or impersonal")
    if text.count("!") > 1:
        warnings.append("more than one '!'")
    if re.search(r"[!?]{2,}|\.{4,}", text):
        warnings.append("repeated punctuation")
    return {"ad_id": ad.get("ad_id"), "length": len(text), "ok": not errors, "errors": errors, "warnings": warnings}


def compute(data, args):
    cfg = {"max_len": int(data.get("max_len", 160)), "max_emoji": int(data.get("max_emoji", 1)),
           "require_erid": bool(data.get("require_erid", True)),
           "abbr": ABBR | set(data.get("abbreviations") or [])}
    ads = data["ads"]
    if not ads:
        raise ValueError("ads is empty")
    results = [lint(a, cfg) for a in ads]
    bad = sum(1 for r in results if not r["ok"])
    return {"results": results, "summary": {"ads": len(results), "failed": bad},
            "verdict": "fail" if bad else "pass", "limits": {"max_len": cfg["max_len"], "max_emoji": cfg["max_emoji"]}}


def main():
    ap = Parser(prog=NAME, description="Pre-moderation lint for Telegram Ads texts and destinations.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--strict", action="store_true", help="exit 3 when any ad fails")
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
