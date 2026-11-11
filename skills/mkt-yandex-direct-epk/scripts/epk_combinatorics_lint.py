#!/usr/bin/env python3
"""EPK pre-mortem lint (Council §6.1 + S-03): every headline x text combination of a RESPONSIVE_AD and the bid-step guard.

Yandex Direct «Единая перфоманс-кампания» assembles ads from up to N headlines and M texts, so one
bad pair is enough to get a moderation reject or a tautological ad. The lint enumerates ALL pairs:
  * limits: headline <= 56 chars, text <= 81 chars, any word <= 23 chars (configurable);
  * tautology: >= 60% of the headline stems repeated in the text;
  * forbidden wording (superlatives / guarantees without proof, ФЗ-38) and CAPS words (>= 5 letters);
  * more than one "!" in the combined ad; missing erid (ad marking) unless erid_mode = "auto".
Any bad combination blocks the order. The S-03 guard protects autostrategy learning: a budget /
CPA / bid change must satisfy |Δ|/current <= 0.15 and now - last_edit >= 120 h, except a DECREASE
made by the automatic cut-off.

Input JSON: {"ads": [{"ad_id", "headlines": [], "texts": [], "erid"}], "erid_mode": "required|auto",
             "limits": {"headline": 56, "text": 81, "word": 23}, "forbidden": [], "tautology_threshold": 0.6,
             "now": "YYYY-MM-DDTHH:MM:SS", "max_step": 0.15, "min_hours": 120,
             "mutations": [{"entity_id", "field", "current", "new", "last_edit_at", "auto_cutoff"}]}
Output JSON: combos_total, bad_combos[], ad_issues[], mutations[] {allowed, reasons[]}, verdict (pass|block).
"""
import argparse
import json
import re
import sys
from datetime import datetime

NAME = "epk_combinatorics_lint.py"
VERSION = "1.0.0"
FORBIDDEN = ["лучший", "лучшая", "лучшее", "лучшие", "самый", "самая", "самое", "№1", "номер один", "номер 1",
             "гарантируем", "гарантия результата", "100%", "лидер рынка", "дешевле всех", "вне конкуренции"]
ENDINGS = sorted(("ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ая", "яя", "ое", "ее", "ые", "ие", "ый",
                  "ий", "ой", "ую", "юю", "ом", "ем", "ам", "ям", "ах", "ях", "ов", "ев", "ей", "ия", "ию", "ть", "ет",
                  "ут", "ют", "ит", "ат", "ят", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й"), key=len, reverse=True)
STOP = {"и", "в", "на", "с", "по", "для", "не", "от", "до", "из", "к", "о", "а", "за", "у", "без"}


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
    "erid_mode": "required", "now": "2026-11-11T10:00:00",
    "ads": [
        {"ad_id": "ra-101", "erid": "2SDnjdLdQ8e",
         "headlines": ["Угловые диваны от производителя", "Диваны на заказ за 14 дней",
                       "Лучший диван в Москве!"],
         "texts": ["Угловые диваны от производителя со скидкой до 30%. Доставка по Москве бесплатно!",
                   "Соберём диван по вашим размерам: 120 тканей, рассрочка 0%, гарантия 3 года."]},
        {"ad_id": "ra-102", "erid": "",
         "headlines": ["Кресла для дома"], "texts": ["Кресла для дома и офиса: 200 моделей в наличии на складе в Москве."]},
    ],
    "mutations": [
        {"entity_id": "camp-7", "field": "budget_week", "current": 70000, "new": 77000, "last_edit_at": "2026-11-01T09:00:00"},
        {"entity_id": "camp-8", "field": "cpa", "current": 1500, "new": 1900, "last_edit_at": "2026-10-20T09:00:00"},
        {"entity_id": "camp-9", "field": "budget_week", "current": 50000, "new": 52000, "last_edit_at": "2026-11-09T09:00:00"},
        {"entity_id": "camp-10", "field": "budget_week", "current": 50000, "new": 20000, "last_edit_at": "2026-11-10T09:00:00",
         "auto_cutoff": True},
    ],
}


def stems(text):
    out = set()
    for t in re.findall(r"[0-9a-zа-яё]+", text.lower().replace("ё", "е")):
        if t in STOP or len(t) < 3:
            continue
        for e in ENDINGS:
            if t.endswith(e) and len(t) - len(e) >= 4:
                t = t[:-len(e)]
                break
        out.add(t)
    return out


def text_issues(s, limit, word_max, forbidden, kind):
    issues = []
    if len(s) > limit:
        issues.append("%s_too_long: %d > %d" % (kind, len(s), limit))
    for w in re.findall(r"\S+", s):
        if len(w.strip(".,!?:;«»\"()")) > word_max:
            issues.append("word_too_long: %s" % w)
        core = re.sub(r"[^A-Za-zА-Яа-яЁё]", "", w)
        if len(core) >= 5 and core.isupper():
            issues.append("caps_word: %s" % w)
    low = s.lower().replace("ё", "е")
    for f in forbidden:
        if f.lower() in low:
            issues.append("forbidden: %s" % f)
    return issues


def compute(data, args):
    lim = dict({"headline": 56, "text": 81, "word": 23}, **(data.get("limits") or {}))
    forbidden = data.get("forbidden") or FORBIDDEN
    taut = float(data.get("tautology_threshold", 0.6))
    erid_mode = data.get("erid_mode", "required")
    total, bad, ad_issues = 0, [], []
    for ad in data["ads"]:
        heads, texts = ad.get("headlines") or [], ad.get("texts") or []
        if not heads or not texts:
            ad_issues.append({"ad_id": ad["ad_id"], "issue": "needs at least one headline and one text"})
            continue
        if erid_mode == "required" and not str(ad.get("erid") or "").strip():
            ad_issues.append({"ad_id": ad["ad_id"], "issue": "missing erid (ad marking): register the creative in ORD"})
        for hi, h in enumerate(heads):
            for ti, t in enumerate(texts):
                total += 1
                issues = text_issues(h, lim["headline"], lim["word"], forbidden, "headline")
                issues += text_issues(t, lim["text"], lim["word"], forbidden, "text")
                hs, ts = stems(h), stems(t)
                share = len(hs & ts) / len(hs) if hs else 0.0
                if share >= taut:
                    issues.append("tautology: %.0f%% of headline stems repeated in text" % (share * 100))
                if (h + " " + t).count("!") > 1:
                    issues.append("exclamation: more than one '!' in the assembled ad")
                if issues:
                    bad.append({"ad_id": ad["ad_id"], "headline_index": hi, "text_index": ti, "headline": h, "text": t,
                                "issues": sorted(set(issues))})
    now = datetime.fromisoformat(args.now or data.get("now") or "1970-01-01T00:00:00")
    max_step, min_h = float(data.get("max_step", 0.15)), float(data.get("min_hours", 120))
    muts = []
    for m in data.get("mutations") or []:
        cur, new = float(m["current"]), float(m["new"])
        step = abs(new - cur) / cur if cur else float("inf")
        hours = (now - datetime.fromisoformat(m["last_edit_at"])).total_seconds() / 3600 if m.get("last_edit_at") else None
        reasons = []
        exempt = bool(m.get("auto_cutoff")) and new < cur
        if not exempt:
            if step > max_step:
                reasons.append("step %.1f%% > %.0f%%" % (step * 100, max_step * 100))
            if hours is not None and hours < min_h:
                reasons.append("last edit %.0f h ago < %.0f h (learning)" % (hours, min_h))
        muts.append({"entity_id": m["entity_id"], "field": m["field"], "step": round(step, 4),
                     "hours_since_edit": None if hours is None else round(hours, 1), "exempt_auto_cutoff": exempt,
                     "allowed": not reasons, "reasons": reasons})
    blocked = bool(bad) or bool(ad_issues) or any(not m["allowed"] for m in muts)
    return {"combos_total": total, "bad_combos": bad, "ad_issues": ad_issues, "mutations": muts,
            "limits": lim, "verdict": "block" if blocked else "pass"}


def main():
    ap = Parser(prog=NAME, description="Lint every headline x text pair of EPK responsive ads + bid-step guard.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--now", help="ISO timestamp for the 120 h guard (default: input now)")
    ap.add_argument("--strict", action="store_true", help="exit 3 when verdict is block")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["verdict"] == "block":
        sys.exit(3)


if __name__ == "__main__":
    main()
