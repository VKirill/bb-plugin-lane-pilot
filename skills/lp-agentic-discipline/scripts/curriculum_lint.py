#!/usr/bin/env python3
"""curriculum_lint.py — copy, secret & watermark lint for distilled course/book material (lp.curriculum-ingest).

Checks distilled .md/.json/.jsonl/.txt drafts or inline items for:
  * quoted spans longer than --max-quote-words (default 25) words;
  * resale / leak watermark tokens (Latin and Cyrillic);
  * leaked API keys / tokens / credentials;
  * 12-word shingle verbatim overlap against --sources above --max-shingle-overlap (default 0.20).
Supports both --fixture / --input FILE|- (common verified-script contract) and --atoms / --questions / --sources
(plugin-db-and-sp-executors-spec §3.2). Standard library only; deterministic JSON output.
"""
import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

SCRIPT = "curriculum_lint.py"
VERSION = "1.0.0"

QUOTE_RE = re.compile(r"«([^»]{1,4000})»|\"([^\"\n]{1,4000})\"|“([^”]{1,4000})”")
WATERMARK_PATTERNS = [
    re.compile("skl" + r"ad\s*chik", re.I),
    re.compile("скл" + r"ад\s*чик", re.I),
    re.compile("sliv" + r"y?\s*sklad", re.I),
    re.compile(r"скачано\s+с", re.I),
    re.compile(r"слив\s+курс", re.I),
    re.compile("course" + r"hunter", re.I),
    re.compile("share" + r"wood", re.I),
]
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    re.compile(r"\by0_[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{25,}\b"),
]
EXT = {".md", ".json", ".jsonl", ".txt"}
SHINGLE = 12


def emit(payload, code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
    return code


def fail(code_name, message, exit_code=2):
    return emit(
        {
            "error": {"code": code_name, "message": str(message)},
            "ok": False,
            "script": SCRIPT,
            "version": VERSION,
        },
        exit_code,
    )


def words(text):
    return re.findall(r"[\w’'-]+", (text or "").lower())


def shingles(text):
    w = words(text)
    if len(w) < SHINGLE:
        return set()
    return {" ".join(w[i : i + SHINGLE]) for i in range(0, len(w) - SHINGLE + 1)}


def collect_paths(paths):
    out = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.is_file() and child.suffix in EXT and child.name != "curriculum_lint.report.json":
                    out.append(child)
        elif p.is_file():
            out.append(p)
        else:
            raise FileNotFoundError(str(p))
    return out


def collect_source_files(paths):
    out = []
    for raw in paths:
        p = Path(raw)
        if p.suffix == ".json" and p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            stack = [data]
            found = []
            while stack:
                cur = stack.pop()
                if isinstance(cur, dict):
                    stack.extend(cur.values())
                elif isinstance(cur, list):
                    stack.extend(cur)
                elif isinstance(cur, str) and len(cur) < 1024 and Path(cur).exists():
                    found.append(cur)
            if found:
                out.extend(collect_paths(found))
        else:
            out.extend(collect_paths([p]))
    return out


def lint_documents(docs, max_words=25, source_texts=(), max_overlap=0.2, report_path=None):
    src_shingles = set()
    for st in source_texts:
        src_shingles |= shingles(st)

    long_quotes = []
    marks = []
    secrets = []
    runs = []

    for doc in docs:
        label = str(doc["name"])
        text = str(doc["text"])
        is_json = label.endswith(".json")
        if not is_json:
            for m in QUOTE_RE.finditer(text):
                span = next(g for g in m.groups() if g is not None)
                n = len(span.split())
                if n > max_words:
                    long_quotes.append({"file": label, "start": span[:60], "words": n})
        for rx in WATERMARK_PATTERNS:
            for m in rx.finditer(text):
                marks.append({"file": label, "match": m.group(0)})
        for rx in SECRET_PATTERNS:
            for m in rx.finditer(text):
                secrets.append({"file": label, "prefix": m.group(0)[:8] + "***"})
        if src_shingles:
            own = shingles(text)
            hit = sorted(own & src_shingles)
            if hit and own:
                share = round(len(hit) / float(len(own)), 4)
                runs.append(
                    {
                        "example": hit[0],
                        "file": label,
                        "over_threshold": share > max_overlap,
                        "share": share,
                        "shared_12gram_count": len(hit),
                    }
                )

    violations_count = (
        len(long_quotes)
        + len(marks)
        + len(secrets)
        + sum(1 for r in runs if r["over_threshold"])
    )
    verdict = "pass" if violations_count == 0 else "block"
    res = {
        "files": len(docs),
        "long_quotes": long_quotes,
        "ok": True,
        "pass": violations_count == 0,
        "report_path": report_path,
        "script": SCRIPT,
        "secrets": secrets,
        "verbatim_runs": runs,
        "verdict": verdict,
        "version": VERSION,
        "violations": violations_count,
        "watermarks": marks,
    }
    if report_path:
        parent = os.path.dirname(os.path.abspath(report_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as wf:
            wf.write(json.dumps(res, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return res


def fixture_payload():
    return {
        "documents": [
            {
                "name": "mkt-unit-economics.md",
                "text": (
                    "# Unit Economics Gate\n\n"
                    "Формула: CAC = spend / paid_orders. Не отключать когорту до P90 lag платежа.\n"
                    "Правило: «Короткая проверенная цитата из шести слов».\n"
                ),
            },
            {
                "name": "questions-sample.md",
                "text": (
                    "## Q-MKT-001\n"
                    "Проверить долю неразмеченного трафика и сходимость кликов с CRM-лидами на окне 14 дней.\n"
                ),
            },
        ],
        "max_quote_words": 25,
        "max_shingle_overlap": 0.2,
        "sources": [
            "Сырой конспект лекции про сквозную аналитику и когортный анализ платежей в воронке продаж за месяц."
        ],
    }


def selftest():
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        (t / "good.md").write_text(
            "Формула: CAC = spend / new_customers. «Короткая цитата из пяти слов».",
            encoding="utf-8",
        )
        wm_token = "skl" + "ad chik"
        (t / "bad.md").write_text(
            "«" + " ".join(["слово"] * 30) + "» и метка " + wm_token,
            encoding="utf-8",
        )
        (t / "src.txt").write_text(" ".join("w%d" % i for i in range(40)), encoding="utf-8")
        (t / "copy.md").write_text(" ".join("w%d" % i for i in range(30)), encoding="utf-8")

        good = lint_documents(
            [{"name": str(t / "good.md"), "text": (t / "good.md").read_text(encoding="utf-8")}],
            25,
            [(t / "src.txt").read_text(encoding="utf-8")],
        )
        bad = lint_documents(
            [{"name": str(t / "bad.md"), "text": (t / "bad.md").read_text(encoding="utf-8")}],
            25,
        )
        copy_res = lint_documents(
            [{"name": str(t / "copy.md"), "text": (t / "copy.md").read_text(encoding="utf-8")}],
            25,
            [(t / "src.txt").read_text(encoding="utf-8")],
            0.2,
        )
        ok = (
            good["pass"]
            and (not bad["pass"])
            and bad["violations"] == 2
            and copy_res["violations"] == 1
        )
        return {
            "bad_findings": bad["violations"],
            "good_pass": good["pass"],
            "ok": ok,
            "script": SCRIPT,
            "selftest": "curriculum_lint",
            "verdict": "pass" if ok else "block",
            "version": VERSION,
        }


class JsonArgParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def load_json_source(src):
    if src == "-":
        raw = sys.stdin.read()
    else:
        with open(src, "r", encoding="utf-8") as f:
            raw = f.read()
    if not raw.strip():
        raise ValueError("empty JSON input")
    return json.loads(raw)


def main(argv):
    if not argv:
        return fail("no_input", "pass --fixture, --input FILE|-, or --atoms/--questions/--dir/--file", 2)
    if "-h" in argv or "--help" in argv:
        ap_help = argparse.ArgumentParser(description=__doc__.splitlines()[0])
        ap_help.add_argument("--fixture", action="store_true", help="run built-in deterministic fixture")
        ap_help.add_argument("--input", help="JSON file path or - for stdin ({documents, sources?, max_quote_words?, max_shingle_overlap?})")
        ap_help.add_argument("--atoms", action="append", default=[], help="atoms file or folder (repeatable)")
        ap_help.add_argument("--questions", action="append", default=[], help="questions file or folder (repeatable)")
        ap_help.add_argument("--sources", action="append", default=[], help="source texts: folder, file, or JSON inventory")
        ap_help.add_argument("--dir", action="append", default=[], help="alias: folder of distilled files")
        ap_help.add_argument("--file", action="append", default=[], help="alias: single file")
        ap_help.add_argument("--source", action="append", default=[], help="alias of --sources")
        ap_help.add_argument("--max-quote-words", type=int, default=25)
        ap_help.add_argument("--max-shingle-overlap", type=float, default=0.2)
        ap_help.add_argument("--report", help="where to write the full report JSON")
        ap_help.add_argument("--strict", action="store_true", help="exit 3 when verdict is block")
        ap_help.add_argument("--selftest", action="store_true", help="run self-test suite")
        ap_help.print_help()
        return 0

    ap = JsonArgParser(add_help=False)
    ap.add_argument("--fixture", action="store_true")
    ap.add_argument("--input")
    ap.add_argument("--atoms", action="append", default=[])
    ap.add_argument("--questions", action="append", default=[])
    ap.add_argument("--sources", action="append", default=[])
    ap.add_argument("--dir", action="append", default=[])
    ap.add_argument("--file", action="append", default=[])
    ap.add_argument("--source", action="append", default=[])
    ap.add_argument("--max-quote-words", type=int, default=None)
    ap.add_argument("--max-shingle-overlap", type=float, default=None)
    ap.add_argument("--report")
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--selftest", action="store_true")

    try:
        args = ap.parse_args(argv)
    except ValueError as exc:
        return fail("usage", str(exc), 2)

    try:
        if args.selftest:
            res = selftest()
            return emit(res, 0 if res["ok"] else 1)

        if args.fixture or args.input:
            data = fixture_payload() if args.fixture else load_json_source(args.input)
            if not isinstance(data, dict):
                return fail("invalid_data", "--input root must be a JSON object", 2)
            raw_docs = data.get("documents")
            raw_paths = data.get("paths") or []
            docs = []
            if isinstance(raw_docs, list):
                for idx, item in enumerate(raw_docs):
                    if not isinstance(item, dict) or "text" not in item:
                        return fail("invalid_data", "each document must have text", 2)
                    docs.append({"name": item.get("name") or ("doc_%d.md" % idx), "text": str(item["text"])})
            if isinstance(raw_paths, list) and raw_paths:
                for fp in collect_paths(raw_paths):
                    docs.append({"name": str(fp), "text": fp.read_text(encoding="utf-8", errors="replace")})
            if not docs:
                return fail("invalid_data", "documents or paths must be non-empty", 2)
            src_list = data.get("sources") or []
            src_texts = [str(s) for s in src_list if isinstance(s, str)]
            max_w = args.max_quote_words if args.max_quote_words is not None else int(data.get("max_quote_words", 25))
            max_ov = (
                args.max_shingle_overlap
                if args.max_shingle_overlap is not None
                else float(data.get("max_shingle_overlap", 0.2))
            )
            report_path = args.report or data.get("report_path")
            res = lint_documents(docs, max_words=max_w, source_texts=src_texts, max_overlap=max_ov, report_path=report_path)
            return emit(res, 3 if (args.strict and not res["pass"]) else 0)

        drafts = args.atoms + args.questions + args.dir + args.file
        if not drafts:
            return fail("no_input", "pass --atoms/--questions/--dir/--file or --fixture/--input", 2)
        files = collect_paths(drafts)
        if not files:
            return fail("invalid_data", "no lintable files found in given paths", 2)
        docs = [{"name": str(f), "text": f.read_text(encoding="utf-8", errors="replace")} for f in files]
        src_files = collect_source_files(args.sources + args.source)
        src_texts = [sf.read_text(encoding="utf-8", errors="replace") for sf in src_files]
        first = Path(drafts[0])
        report_target = (
            str(Path(args.report))
            if args.report
            else str((first if first.is_dir() else first.parent) / "curriculum_lint.report.json")
        )
        max_w = args.max_quote_words if args.max_quote_words is not None else 25
        max_ov = args.max_shingle_overlap if args.max_shingle_overlap is not None else 0.2
        res = lint_documents(docs, max_words=max_w, source_texts=src_texts, max_overlap=max_ov, report_path=report_target)
        return emit(res, 3 if (args.strict and not res["pass"]) else 0)
    except json.JSONDecodeError as exc:
        return fail("bad_input", "invalid JSON: %s" % exc, 2)
    except FileNotFoundError as exc:
        return fail("bad_input", "path not found: %s" % exc, 2)
    except (OSError, ValueError) as exc:
        return fail("invalid_data", str(exc), 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
