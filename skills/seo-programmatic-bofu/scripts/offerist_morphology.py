#!/usr/bin/env python3
"""Offerist morphology: stem Russian/English queries, group them into intent clusters and tag the BOFU page type.

Distilled from the Kotenkov «Offerist» demand analysis and the AI Programmatic SEO BOFU matrix
(Comparison «X vs Y», «Alternative to X», Migration, Integration, Role/Use-case, Pricing) under the
DrMax filter: one cluster = one page, the key is the set of stems without stop words, so «купить
диван угловой» and «угловые диваны купить» land in one cluster.

Stemmer: a compact Snowball-Russian (RV/R2 regions, gerund / reflexive / adjectival / verb / noun /
derivational / superlative steps); Latin tokens are lowercased as brands/entities.

Input JSON: {"queries": [{"query", "frequency"}] | ["query", ...], "stop_words": [],
             "aliases": {"битрикс24": "bitrix24"}  (entity spelling map, optional)}
Output JSON: clusters[] {key, page_type, head, entities, queries[], frequency}, counts{page_type: n}.
"""
import argparse
import json
import re
import sys

NAME = "offerist_morphology.py"
VERSION = "1.0.0"
VOWELS = "аеиоуыэюя"
STOP = {"в", "во", "на", "для", "и", "или", "с", "со", "по", "как", "что", "это", "от", "до", "из", "к", "ко",
        "о", "об", "у", "за", "the", "a", "an", "for", "to", "of", "and", "or", "in", "on", "with", "vs", "versus"}
PATTERNS = [
    ("comparison", r"(\bvs\b|\bversus\b|\bили\b|\bпротив\b|сравнени|\bлучше\b.*\bчем\b)"),
    ("alternative", r"(аналог|альтернатив|\bвместо\b|замен|alternative)"),
    ("migration", r"(переход\w* с|перенос|миграц|переехать|migrat)"),
    ("integration", r"(интеграц|подключ\w* к|связк|integrat|\bapi\b)"),
    ("pricing", r"(цен|стоимост|тариф|сколько стоит|прайс|pricing|price)"),
    ("role_use_case", r"(\bдля\s+\w+|\bfor\s+\w+)"),
]

PERFECTIVE_1, PERFECTIVE_2 = ("вшись", "вши", "в"), ("ывшись", "ившись", "ывши", "ивши", "ыв", "ив")
REFLEXIVE = ("ся", "сь")
ADJECTIVE = ("ими", "ыми", "его", "ого", "ему", "ому", "ее", "ие", "ые", "ое", "ей", "ий", "ый", "ой", "ем", "им",
             "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею")
PARTICIPLE_1, PARTICIPLE_2 = ("ем", "нн", "вш", "ющ", "щ"), ("ивш", "ывш", "ующ")
VERB_1 = ("ла", "на", "ете", "йте", "ли", "й", "л", "ем", "н", "ло", "но", "ет", "ют", "ны", "ть", "ешь", "нно")
VERB_2 = ("ила", "ыла", "ена", "ейте", "уйте", "ите", "или", "ыли", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ило",
          "ыло", "ено", "ят", "ует", "уют", "ит", "ыт", "ены", "ить", "ыть", "ишь", "ую", "ю")
NOUN = ("иями", "ями", "ами", "ией", "иям", "ием", "иях", "ев", "ов", "ие", "ье", "еи", "ии", "ей", "ой", "ий", "ям",
        "ем", "ам", "ом", "ах", "ях", "ию", "ью", "ия", "ья", "а", "е", "и", "й", "о", "у", "ы", "ь", "ю", "я")
SUPERLATIVE, DERIVATIONAL = ("ейше", "ейш"), ("ость", "ост")


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


FIXTURE = {"aliases": {"битрикс24": "bitrix24", "амосрм": "amocrm"}, "queries": [
    {"query": "amocrm vs bitrix24", "frequency": 880}, {"query": "битрикс24 или amocrm что лучше", "frequency": 320},
    {"query": "аналог amocrm", "frequency": 590}, {"query": "аналоги amocrm бесплатные", "frequency": 140},
    {"query": "переход с bitrix24 на amocrm", "frequency": 90}, {"query": "интеграция amocrm с 1с", "frequency": 480},
    {"query": "crm для стоматологии", "frequency": 260}, {"query": "crm для стоматологий", "frequency": 40},
    {"query": "amocrm цена", "frequency": 1900}, {"query": "стоимость amocrm", "frequency": 210},
    {"query": "купить диван угловой", "frequency": 5000}, {"query": "угловые диваны купить", "frequency": 2400},
]}


def regions(w):
    rv = next((i + 1 for i, ch in enumerate(w) if ch in VOWELS), len(w))
    r1 = next((i + 1 for i in range(1, len(w)) if w[i] not in VOWELS and w[i - 1] in VOWELS), len(w))
    r2 = next((i + 1 for i in range(r1 + 1, len(w)) if w[i] not in VOWELS and w[i - 1] in VOWELS), len(w))
    return rv, r2


def strip(w, start, endings, need_ay=False):
    for e in sorted(endings, key=len, reverse=True):
        if w.endswith(e) and len(w) - len(e) >= start:
            if need_ay:
                pos = len(w) - len(e) - 1
                if pos < start or w[pos] not in "ая":
                    continue
            return w[:-len(e)]
    return None


def stem_ru(word):
    w = word.lower().replace("ё", "е")
    rv, r2 = regions(w)
    s = strip(w, rv, PERFECTIVE_1, True) or strip(w, rv, PERFECTIVE_2)
    if s is None:
        w = strip(w, rv, REFLEXIVE) or w
        adj = strip(w, rv, ADJECTIVE)
        if adj is not None:
            s = strip(adj, rv, PARTICIPLE_1, True) or strip(adj, rv, PARTICIPLE_2) or adj
        else:
            s = strip(w, rv, VERB_1, True) or strip(w, rv, VERB_2) or strip(w, rv, NOUN) or w
    w = s
    if w.endswith("и") and len(w) - 1 >= rv:
        w = w[:-1]
    w = strip(w, r2, DERIVATIONAL) or w
    if w.endswith("нн"):
        w = w[:-1]
    else:
        sup = strip(w, rv, SUPERLATIVE)
        if sup is not None:
            w = sup[:-1] if sup.endswith("нн") else sup
        elif w.endswith("ь") and len(w) - 1 >= rv:
            w = w[:-1]
    return w


def tokens(text):
    return re.findall(r"[0-9a-zа-яё]+", text.lower().replace("ё", "е"))


ALIASES = {}


def stem(tok):
    tok = ALIASES.get(tok, tok)
    if re.fullmatch(r"[а-я]+", tok):
        return stem_ru(tok)
    return tok


def page_type(q):
    low = q.lower().replace("ё", "е")
    for name, pat in PATTERNS:
        if re.search(pat, low):
            return name
    return "generic"


def compute(data, args):
    raw = data["queries"]
    rows = [{"query": r, "frequency": 0} if isinstance(r, str) else r for r in raw]
    stop = STOP | set(data.get("stop_words") or [])
    ALIASES.clear()
    ALIASES.update({k.lower(): v.lower() for k, v in (data.get("aliases") or {}).items()})
    clusters = {}
    for r in rows:
        q = str(r["query"]).strip()
        toks = [t for t in tokens(q) if t not in stop]
        stems = sorted({stem(t) for t in toks} - {"лучш", "что"})
        key = " ".join(stems)
        if not key:
            continue
        c = clusters.setdefault(key, {"key": key, "queries": [], "frequency": 0.0, "types": {}, "entities": set()})
        c["queries"].append({"query": q, "frequency": float(r.get("frequency") or 0)})
        c["frequency"] += float(r.get("frequency") or 0)
        t = page_type(q)
        c["types"][t] = c["types"].get(t, 0) + float(r.get("frequency") or 0) + 1e-6
        c["entities"].update(stem(x) for x in toks if re.fullmatch(r"[a-z0-9]+", stem(x)) and not x.isdigit())
    out, counts = [], {}
    for key in sorted(clusters):
        c = clusters[key]
        qs = sorted(c["queries"], key=lambda x: (-x["frequency"], x["query"]))
        ptype = max(sorted(c["types"]), key=lambda k: c["types"][k])
        counts[ptype] = counts.get(ptype, 0) + 1
        out.append({"key": key, "page_type": ptype, "head": qs[0]["query"], "entities": sorted(c["entities"]),
                    "queries": qs, "frequency": c["frequency"]})
    out.sort(key=lambda c: (-c["frequency"], c["key"]))
    return {"clusters": out, "counts": counts, "input_queries": len(rows)}


def main():
    ap = Parser(prog=NAME, description="Stem queries, group into clusters and tag BOFU page types.")
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
