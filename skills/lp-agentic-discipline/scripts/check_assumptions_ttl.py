#!/usr/bin/env python3
"""Assumptions TTL check: every working assumption of an autonomous agent carries a source and an expiry.

Distilled from the Peshkov «Agentic Discipline» rules and the Lane Pilot hygiene of learnings.md:
no number from memory, every assumption has a source and a TTL, an expired assumption must be
re-verified before it is used again.
  expired       ttl date < as_of                                  -> error
  expiring      ttl within warn_days                              -> warning
  no_ttl        neither ttl nor created + default_ttl_days         -> error
  no_source     no source                                         -> warning (error if it holds a number)
  number_from_memory   a number in the text and no source         -> error

Input: JSON {"as_of", "warn_days": 7, "default_ttl_days": 30,
             "assumptions": [{"id", "text", "source", "ttl" | "created"}]}
   or  --markdown learnings.md with lines like
       - [A-12] Конверсия лендинга 3.1% (source: metrika 2026-10; ttl: 2026-11-30)
       - [A-13] Клиент не меняет цены до января (created: 2026-11-01)
Output JSON: items[] {id, status, ttl, days_left, issues[]}, counts{}, verdict (pass|fail).
"""
import argparse
import json
import re
import sys
from datetime import date, timedelta

NAME = "check_assumptions_ttl.py"
VERSION = "1.0.0"
LINE_RE = re.compile(r"^\s*[-*]\s*\[(?P<id>[^\]]+)\]\s*(?P<text>.*?)\s*(\((?P<meta>[^()]*)\))?\s*$")
NUM_RE = re.compile(r"\d+(?:[.,]\d+)?\s*%?")


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
    if args.markdown:
        try:
            with open(args.markdown, encoding="utf-8") as fh:
                return {"assumptions": parse_markdown(fh.read())}
        except OSError as exc:
            fail("bad_input", "%s: %s" % (args.markdown, exc), 2)
    if not args.input:
        fail("no_input", "pass --input FILE.json, --markdown FILE.md or --fixture", 2)
    try:
        if args.input == "-":
            return json.load(sys.stdin)
        with open(args.input, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        fail("bad_input", "%s: %s" % (args.input, exc), 2)


def parse_markdown(text):
    items = []
    for line in text.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        item = {"id": m.group("id").strip(), "text": m.group("text").strip()}
        for part in (m.group("meta") or "").split(";"):
            if ":" in part:
                k, v = part.split(":", 1)
                item[k.strip().lower()] = v.strip()
        items.append(item)
    return items


FIXTURE = {"as_of": "2026-11-11", "warn_days": 7, "default_ttl_days": 30, "assumptions": parse_markdown(
    "- [A-1] Конверсия лендинга 3.1% (source: metrika 2026-10; ttl: 2026-11-30)\n"
    "- [A-2] Средний чек 4 900 руб (ttl: 2026-12-31)\n"
    "- [A-3] Клиент не меняет цены до января (source: письмо клиента; created: 2026-10-01)\n"
    "- [A-4] Сезонный спад в декабре (source: YoY Метрика; ttl: 2026-11-15)\n"
    "- [A-5] Бренд-запросы растут\n")}


def compute(data, args):
    as_of = date.fromisoformat(args.as_of or data.get("as_of") or "")
    warn = int(data.get("warn_days", 7))
    default_ttl = data.get("default_ttl_days", 30)
    rows, counts = [], {}
    items = data["assumptions"]
    if not items:
        raise ValueError("no assumptions found")
    for a in items:
        issues, ttl = [], None
        if a.get("ttl"):
            ttl = date.fromisoformat(str(a["ttl"]))
        elif a.get("created") and default_ttl is not None:
            ttl = date.fromisoformat(str(a["created"])) + timedelta(days=int(default_ttl))
        has_num = bool(NUM_RE.search(str(a.get("text") or "")))
        src = str(a.get("source") or "").strip()
        if ttl is None:
            issues.append({"code": "no_ttl", "level": "error"})
        if not src:
            issues.append({"code": "number_from_memory" if has_num else "no_source", "level": "error" if has_num else "warning"})
        days_left = (ttl - as_of).days if ttl else None
        if days_left is not None and days_left < 0:
            issues.append({"code": "expired", "level": "error"})
        elif days_left is not None and days_left <= warn:
            issues.append({"code": "expiring", "level": "warning"})
        status = "invalid" if any(i["code"] in ("no_ttl", "number_from_memory") for i in issues) else (
            "expired" if any(i["code"] == "expired" for i in issues) else (
                "expiring" if any(i["level"] == "warning" for i in issues) else "ok"))
        counts[status] = counts.get(status, 0) + 1
        rows.append({"id": a.get("id"), "text": a.get("text"), "source": src or None,
                     "ttl": ttl.isoformat() if ttl else None, "days_left": days_left, "status": status, "issues": issues})
    errors = sum(1 for r in rows for i in r["issues"] if i["level"] == "error")
    return {"as_of": as_of.isoformat(), "items": rows, "counts": counts, "errors": errors,
            "verdict": "fail" if errors else "pass"}


def main():
    ap = Parser(prog=NAME, description="Check TTL and sources of agent assumptions (JSON or learnings.md).")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--markdown", help="learnings.md style file with '- [ID] text (source: ..; ttl: ..)' lines")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--as-of", help="check date YYYY-MM-DD (required for --markdown unless in input)")
    ap.add_argument("--strict", action="store_true", help="exit 3 when verdict is fail")
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
