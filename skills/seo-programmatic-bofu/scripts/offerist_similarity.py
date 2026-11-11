#!/usr/bin/env python3
"""Offerist similarity: pairwise similarity of programmatic page drafts (TF-IDF cosine + stem 3-shingles).

Part of the Scaled Content Abuse gate for programmatic BOFU pages. Council S-06: cosine < 0.72 alone
lets LLM-paraphrased «empty» pages through, so this script reports BOTH lexical cosine and shingle
overlap, flags duplicates (cosine >= 0.72) and paraphrase risk (cosine >= 0.50 or shingles >= 0.30),
and hands every flagged pair to the 3-stage information-gain gate (cannibalization_guard.py).

Light stemmer: lowercase, ё->е, strip the longest common Russian/English inflection (stem >= 4 chars).

Input JSON: {"pages": [{"id", "title", "text"}], "dup_cosine": 0.72, "para_cosine": 0.50, "para_shingle": 0.30}
Output JSON: pairs[] {a, b, cosine, shingle_jaccard, title_jaccard, flag}, pages[] {id, max_cosine, nearest},
             flagged_count.
"""
import argparse
import json
import math
import re
import sys
from itertools import combinations

NAME = "offerist_similarity.py"
VERSION = "1.0.0"
ENDINGS = sorted(("иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ость", "ости", "ая", "яя", "ое", "ее",
                  "ые", "ие", "ый", "ий", "ой", "ую", "юю", "ом", "ем", "ам", "ям", "ах", "ях", "ов", "ев", "ей", "ия",
                  "ию", "ть", "ет", "ут", "ют", "ит", "ат", "ят", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й",
                  "ing", "ed", "es", "s"), key=len, reverse=True)
STOP = {"и", "в", "на", "с", "по", "для", "не", "что", "это", "как", "или", "от", "до", "из", "к", "о", "а", "но",
        "the", "a", "an", "and", "or", "of", "to", "in", "for", "is", "are", "with"}


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


FIXTURE = {"pages": [
    {"id": "amocrm-vs-bitrix24", "title": "amoCRM или Битрикс24: что выбрать",
     "text": "amoCRM проще во внедрении, Битрикс24 даёт больше модулей. Тариф amoCRM от 499 руб за пользователя, "
             "Битрикс24 имеет бесплатный тариф до 5 пользователей. Для отдела продаж из 10 человек amoCRM быстрее."},
    {"id": "bitrix24-vs-amocrm", "title": "Битрикс24 или amoCRM: что лучше",
     "text": "Битрикс24 даёт больше модулей, amoCRM проще во внедрении. Тариф amoCRM от 499 руб за пользователя, "
             "у Битрикс24 есть бесплатный тариф до 5 пользователей. Отделу продаж из 10 человек быстрее amoCRM."},
    {"id": "amocrm-alternatives", "title": "Аналоги amoCRM",
     "text": "Рассмотрим 7 аналогов amoCRM: RetailCRM для интернет-магазинов, Мегаплан для проектов, "
             "Bpium для конструктора процессов. Сравнили интеграции с 1С и телефонией."},
]}


def light_stem(tok):
    for e in ENDINGS:
        if tok.endswith(e) and len(tok) - len(e) >= 4:
            return tok[:-len(e)]
    return tok


def stems(text):
    toks = re.findall(r"[0-9a-zа-яё]+", (text or "").lower().replace("ё", "е"))
    return [light_stem(t) for t in toks if t not in STOP]


def shingles(seq, k=3):
    return {tuple(seq[i:i + k]) for i in range(max(0, len(seq) - k + 1))}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a | b else 0.0


def compute(data, args):
    pages = data["pages"]
    if len(pages) < 2:
        raise ValueError("need at least 2 pages")
    ids = [str(p["id"]) for p in pages]
    if len(set(ids)) != len(ids):
        raise ValueError("page ids must be unique")
    dup_c = float(data.get("dup_cosine", 0.72))
    para_c, para_s = float(data.get("para_cosine", 0.50)), float(data.get("para_shingle", 0.30))
    docs = [stems((p.get("title") or "") + " " + (p.get("text") or "")) for p in pages]
    df = {}
    for d in docs:
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    n = len(docs)
    vecs = []
    for d in docs:
        tf = {}
        for t in d:
            tf[t] = tf.get(t, 0) + 1
        v = {t: c * (math.log((1 + n) / (1 + df[t])) + 1) for t, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({t: x / norm for t, x in v.items()})
    sh = [shingles(d) for d in docs]
    titles = [set(stems(p.get("title"))) for p in pages]
    pairs = []
    for i, j in combinations(range(n), 2):
        cos = sum(x * vecs[j].get(t, 0.0) for t, x in vecs[i].items())
        sj, tj = jaccard(sh[i], sh[j]), jaccard(titles[i], titles[j])
        flag = "duplicate" if cos >= dup_c else ("paraphrase_risk" if cos >= para_c or sj >= para_s else "ok")
        pairs.append({"a": ids[i], "b": ids[j], "cosine": round(cos, 4), "shingle_jaccard": round(sj, 4),
                      "title_jaccard": round(tj, 4), "flag": flag,
                      "gate": "information_gain_required" if flag != "ok" else "none"})
    pairs.sort(key=lambda p: (-p["cosine"], p["a"], p["b"]))
    per = []
    for k in ids:
        mine = [p for p in pairs if k in (p["a"], p["b"])]
        top = max(mine, key=lambda p: p["cosine"])
        per.append({"id": k, "max_cosine": top["cosine"], "nearest": top["b"] if top["a"] == k else top["a"]})
    return {"pairs": pairs, "pages": per, "flagged_count": sum(1 for p in pairs if p["flag"] != "ok"),
            "thresholds": {"dup_cosine": dup_c, "para_cosine": para_c, "para_shingle": para_s}}


def main():
    ap = Parser(prog=NAME, description="Pairwise similarity of page drafts (TF-IDF cosine + shingles).")
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
