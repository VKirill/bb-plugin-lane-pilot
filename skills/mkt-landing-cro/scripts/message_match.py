#!/usr/bin/env python3
"""message_match.py — deterministic ad-to-landing message match (code gate of sp.message_match).

Checks stem overlap of (keyword + title + text) against (h1 + title + first_screen) of the landing page,
price equality (numbers next to currency tokens), and optional erid marker presence.
Supports both --fixture / --input FILE|- (common verified-script contract) and --ads / --capture CLI flags
(plugin-db-and-sp-executors-spec §3.2). Standard library only; deterministic JSON output.
"""
import argparse
import json
import os
import re
import sys

SCRIPT = "message_match.py"
VERSION = "1.0.0"

STOP = set(
    "и в во на с со по для от до из к ко о об а но или не что как это за у же ли бы вы мы мой наш ваш "
    "the a an of to for in on and or with from by at".split()
)
PRICE_RE = re.compile(r"(\d[\d\s]{0,9}\d|\d)\s*(?:₽|руб\.?|р\.|\$|€)", re.I)


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


def stems(text):
    out = set()
    norm = (text or "").lower().replace("ё", "е")
    for w in re.findall(r"[a-zа-я0-9]+", norm):
        if w in STOP or len(w) < 3:
            continue
        out.add(w[:5] if len(w) > 5 else w)
    return out


def prices(text):
    return {int(re.sub(r"\s", "", m.group(1))) for m in PRICE_RE.finditer(text or "")}


def flatten_landing(capture):
    if isinstance(capture.get("viewports"), dict):
        merged = {}
        for key in ("h1", "title", "first_screen"):
            parts = []
            for vp in sorted(capture["viewports"].keys()):
                val = capture["viewports"][vp]
                if isinstance(val, dict) and val.get(key):
                    parts.append(str(val.get(key, "")))
            merged[key] = " ".join(parts)
        res = dict(capture)
        res.update(merged)
        return res
    return dict(capture)


def evaluate(ads, landing, threshold=0.5, require_erid=False, report_path=None):
    flat = flatten_landing(landing)
    land_text = " ".join(str(flat.get(k, "")) for k in ("h1", "title", "first_screen"))
    land_stems = stems(land_text)
    land_prices = prices(land_text)
    if str(flat.get("price", "")).isdigit():
        land_prices.add(int(flat["price"]))

    mismatches = []
    per_ad = []
    erid_missing = []
    scores = []
    price_bad_any = False

    for idx, ad in enumerate(ads):
        if not isinstance(ad, dict):
            raise ValueError("each ad item must be an object")
        ad_id = str(ad.get("id") or ad.get("ad_id") or ("ad_%d" % (idx + 1)))
        ad_text = " ".join(
            str(ad.get(k, ""))
            for k in ("keyword", "title", "headline", "text", "offer")
        )
        ad_stems = stems(ad_text)
        score = round(len(ad_stems & land_stems) / float(len(ad_stems)), 3) if ad_stems else 0.0
        scores.append(score)

        ad_prices = set(prices(ad_text))
        if str(ad.get("price", "")).isdigit():
            ad_prices.add(int(ad["price"]))
        p_bad = bool(ad_prices) and not ad_prices.issubset(land_prices)
        price_bad_any = price_bad_any or p_bad

        has_erid = bool(str(ad.get("erid", "")).strip())
        if require_erid and not has_erid:
            erid_missing.append(ad_id)

        missing_tokens = sorted(ad_stems - land_stems)[:10]
        row = {
            "ad_id": ad_id,
            "erid_ok": (not require_erid) or has_erid,
            "matched_stems": sorted(ad_stems & land_stems),
            "missing_on_landing": missing_tokens,
            "pass": (score >= threshold) and (not p_bad) and ((not require_erid) or has_erid),
            "price_mismatch": p_bad,
            "score": score,
        }
        per_ad.append(row)
        if score < threshold or p_bad:
            mismatches.append(
                {
                    "ad_id": ad_id,
                    "missing_on_landing": missing_tokens,
                    "price_mismatch": p_bad,
                    "score": score,
                }
            )

    min_score = min(scores) if scores else 0.0
    passed = (len(mismatches) == 0) and (len(erid_missing) == 0) and (len(ads) > 0)
    verdict = "pass" if passed else "fail"
    result = {
        "ads_checked": len(ads),
        "erid_missing": erid_missing,
        "min_score": min_score,
        "mismatch_items": mismatches,
        "mismatches": len(mismatches),
        "ok": True,
        "pass": passed,
        "per_ad": per_ad,
        "price_mismatch": price_bad_any,
        "report_path": report_path,
        "script": SCRIPT,
        "threshold": float(threshold),
        "verdict": verdict,
        "version": VERSION,
    }
    if report_path:
        parent = os.path.dirname(os.path.abspath(report_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as wf:
            wf.write(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return result


def fixture_payload():
    return {
        "ads": [
            {
                "erid": "2VtzqvX9AbC",
                "id": "ad_divan_msk",
                "keyword": "химчистка диванов москва",
                "price": 990,
                "text": "Выезд мастера за 2 часа, сушка в день заказа",
                "title": "Химчистка диванов в Москве от 990 ₽",
            },
            {
                "erid": "2VtzqvX9AbD",
                "id": "ad_kreslo_msk",
                "keyword": "химчистка мебели выезд",
                "text": "Сушка в день заказа от 990 ₽",
                "title": "Химчистка мебели в Москве",
            },
        ],
        "landing": {
            "first_screen": "Выезд мастера за 2 часа по Москве, безопасная сушка в день заказа, цена от 990 ₽",
            "h1": "Химчистка диванов и мягкой мебели в Москве от 990 ₽",
            "title": "Химчистка мебели в Москве — выезд за 2 часа",
            "url": "https://clean-example.ru/divany",
        },
        "require_erid": True,
        "threshold": 0.5,
    }


def selftest():
    fx = fixture_payload()
    good = evaluate(fx["ads"], fx["landing"], fx["threshold"], fx["require_erid"])
    bad_ads = [
        {
            "erid": "",
            "id": "ad_bad",
            "keyword": "чистка ковров казань",
            "text": "Вывоз в цех Казань",
            "title": "Чистка ковров от 1490 ₽",
        }
    ]
    bad = evaluate(bad_ads, {"viewports": {"375x812": fx["landing"]}}, 0.5, True)
    ok = (
        good["pass"]
        and not bad["pass"]
        and bad["price_mismatch"]
        and bad["mismatches"] == 1
        and bad["erid_missing"] == ["ad_bad"]
    )
    return {
        "bad_min_score": bad["min_score"],
        "good_min_score": good["min_score"],
        "ok": ok,
        "script": SCRIPT,
        "selftest": "message_match",
        "verdict": "pass" if ok else "fail",
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
        return fail("no_input", "pass --fixture, --input FILE|-, or --ads and --capture")
    if "-h" in argv or "--help" in argv:
        ap_help = argparse.ArgumentParser(description=__doc__.splitlines()[0])
        ap_help.add_argument("--fixture", action="store_true", help="run built-in deterministic fixture")
        ap_help.add_argument("--input", help="JSON file path or - for stdin ({ads, landing, threshold?, require_erid?})")
        ap_help.add_argument("--ads", help="ads JSON file ([{id, keyword, title, text, price?, erid?}])")
        ap_help.add_argument("--capture", "--landing", dest="landing", help="landing / first-screen capture JSON file")
        ap_help.add_argument("--threshold", type=float, default=None, help="minimum stem overlap score (default 0.5)")
        ap_help.add_argument("--require-erid", action="store_true", help="require non-empty erid on every ad")
        ap_help.add_argument("--report", help="optional path to write JSON report")
        ap_help.add_argument("--strict", action="store_true", help="exit 3 when verdict is fail")
        ap_help.add_argument("--selftest", action="store_true", help="run self-test suite")
        ap_help.print_help()
        return 0

    ap = JsonArgParser(add_help=False)
    ap.add_argument("--fixture", action="store_true")
    ap.add_argument("--input")
    ap.add_argument("--ads")
    ap.add_argument("--capture", "--landing", dest="landing")
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--require-erid", action="store_true")
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

        if args.fixture:
            data = fixture_payload()
        elif args.input:
            data = load_json_source(args.input)
            if not isinstance(data, dict):
                return fail("invalid_data", "--input root must be a JSON object", 2)
        elif args.ads and args.landing:
            ads_obj = load_json_source(args.ads)
            land_obj = load_json_source(args.landing)
            if isinstance(ads_obj, dict) and isinstance(ads_obj.get("ads"), list):
                ads_obj = ads_obj["ads"]
            data = {"ads": ads_obj, "landing": land_obj}
        else:
            return fail("no_input", "pass --fixture, --input, or both --ads and --capture", 2)

        ads = data.get("ads")
        landing = data.get("landing") or data.get("capture") or data.get("page")
        if not isinstance(ads, list) or len(ads) == 0:
            return fail("invalid_data", "ads must be a non-empty list", 2)
        if not isinstance(landing, dict):
            return fail("invalid_data", "landing must be a JSON object", 2)

        threshold = args.threshold if args.threshold is not None else float(data.get("threshold", 0.5))
        require_erid = bool(args.require_erid or data.get("require_erid", False))
        report_path = args.report or data.get("report_path")

        res = evaluate(ads, landing, threshold=threshold, require_erid=require_erid, report_path=report_path)
        exit_code = 3 if (args.strict and res["verdict"] != "pass") else 0
        return emit(res, exit_code)
    except json.JSONDecodeError as exc:
        return fail("bad_input", "invalid JSON: %s" % exc, 2)
    except FileNotFoundError as exc:
        return fail("bad_input", "file not found: %s" % exc, 2)
    except (OSError, ValueError) as exc:
        return fail("invalid_data", str(exc), 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
