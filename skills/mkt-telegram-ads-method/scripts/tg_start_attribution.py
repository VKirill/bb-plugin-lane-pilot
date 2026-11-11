#!/usr/bin/env python3
"""Telegram Ads start= attribution: join bot /start payloads to ad stats and downstream conversions.

Official Telegram Ads have no pixel; the method is one ad = one deep link t.me/<bot>?start=<payload>
(1-to-1). This script parses the payloads from bot logs with a configurable scheme, attributes each
user to the FIRST valid start (first touch), counts conversions inside the attribution window and
reports per ad: unique starts, view->start rate, cost per start, conversions, revenue, ROAS, plus
invalid payloads and the unattributed share.

Input JSON: {"payload_regex": optional scheme with named groups key and variant
             (default: <campaign>_<ad>[_<variant>], lowercase alphanumerics), "window_days": 7,
             "ads": [{"payload_key", "ad_id", "views", "spend", "currency"}],
             "starts": [{"user_id", "payload", "ts"}], "conversions": [{"user_id", "value", "ts"}]}
Output JSON: ads[] {payload_key, starts, view_to_start, cost_per_start, conversions, revenue, roas},
             invalid_payloads[], unknown_keys[], totals{}.
"""
import argparse
import json
import re
import sys
from datetime import datetime, timedelta

NAME = "tg_start_attribution.py"
VERSION = "1.0.0"
PAYLOAD_SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DEFAULT_RE = r"^(?P<key>[a-z0-9]+_[a-z0-9]+)(?:_(?P<variant>[a-z0-9]+))?$"


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
    "window_days": 7,
    "ads": [{"payload_key": "c12_a1", "ad_id": "tg-881", "views": 52000, "spend": 180.0, "currency": "EUR"},
            {"payload_key": "c12_a2", "ad_id": "tg-882", "views": 48000, "spend": 160.0, "currency": "EUR"},
            {"payload_key": "c13_a1", "ad_id": "tg-890", "views": 9000, "spend": 40.0, "currency": "EUR"}],
    "starts": [
        {"user_id": 1, "payload": "c12_a1", "ts": "2026-11-01T10:00:00"},
        {"user_id": 1, "payload": "c12_a2", "ts": "2026-11-02T10:00:00"},
        {"user_id": 2, "payload": "c12_a1_v2", "ts": "2026-11-01T12:00:00"},
        {"user_id": 3, "payload": "c12_a2", "ts": "2026-11-03T09:00:00"},
        {"user_id": 4, "payload": "", "ts": "2026-11-03T09:30:00"},
        {"user_id": 5, "payload": "promo spring!", "ts": "2026-11-04T09:30:00"},
        {"user_id": 6, "payload": "c99_a9", "ts": "2026-11-04T10:00:00"},
        {"user_id": 7, "payload": "c12_a1", "ts": "2026-11-05T10:00:00"},
    ],
    "conversions": [{"user_id": 1, "value": 2990, "ts": "2026-11-03T10:00:00"},
                    {"user_id": 3, "value": 1490, "ts": "2026-11-20T10:00:00"},
                    {"user_id": 7, "value": 2990, "ts": "2026-11-06T10:00:00"}],
}


def ts(s):
    return datetime.fromisoformat(str(s).replace("Z", "+00:00")).replace(tzinfo=None)


def compute(data, args):
    rx = re.compile(data.get("payload_regex") or DEFAULT_RE)
    window = timedelta(days=float(data.get("window_days", 7)))
    ads = {a["payload_key"]: a for a in data["ads"]}
    first, invalid, unknown = {}, [], {}
    for s in sorted(data.get("starts") or [], key=lambda x: (ts(x["ts"]), str(x["user_id"]))):
        p = str(s.get("payload") or "")
        m = rx.match(p) if PAYLOAD_SAFE.match(p) else None
        if not m:
            invalid.append({"user_id": s["user_id"], "payload": p, "reason": "empty" if not p else "does not match scheme"})
            continue
        key = m.groupdict().get("key") or p
        if key not in ads:
            unknown[key] = unknown.get(key, 0) + 1
            continue
        first.setdefault(str(s["user_id"]), (key, ts(s["ts"]), m.groupdict().get("variant")))
    conv = {}
    for c in data.get("conversions") or []:
        conv.setdefault(str(c["user_id"]), []).append((ts(c["ts"]), float(c.get("value") or 0)))
    stats = {k: {"starts": 0, "conversions": 0, "revenue": 0.0, "variants": {}} for k in ads}
    for uid, (key, t0, variant) in first.items():
        st = stats[key]
        st["starts"] += 1
        if variant:
            st["variants"][variant] = st["variants"].get(variant, 0) + 1
        hits = [v for t, v in conv.get(uid, []) if t0 <= t <= t0 + window]
        if hits:
            st["conversions"] += 1
            st["revenue"] += sum(hits)
    rows = []
    for k in sorted(ads):
        a, st = ads[k], stats[k]
        spend, views = float(a.get("spend") or 0), float(a.get("views") or 0)
        rows.append({"payload_key": k, "ad_id": a.get("ad_id"), "currency": a.get("currency"), "views": views,
                     "spend": spend, "starts": st["starts"], "variants": st["variants"],
                     "view_to_start": round(st["starts"] / views, 6) if views else None,
                     "cost_per_start": round(spend / st["starts"], 4) if st["starts"] else None,
                     "conversions": st["conversions"], "revenue": round(st["revenue"], 2),
                     "cost_per_conversion": round(spend / st["conversions"], 4) if st["conversions"] else None,
                     "start_to_conversion": round(st["conversions"] / st["starts"], 4) if st["starts"] else None})
    total_starts = len(data.get("starts") or [])
    users = len({str(s["user_id"]) for s in data.get("starts") or []})
    return {"ads": rows, "invalid_payloads": invalid,
            "unknown_keys": [{"payload_key": k, "starts": n} for k, n in sorted(unknown.items())],
            "totals": {"start_events": total_starts, "users": users, "attributed_users": len(first),
                       "unattributed_share": round(1 - len(first) / users, 4) if users else None,
                       "window_days": window.days, "model": "first_touch"},
            "note": "revenue and spend currencies are not converted; compare ROAS only within one currency"}


def main():
    ap = Parser(prog=NAME, description="Attribute Telegram Ads via bot start= payloads (first touch).")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError, re.error) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
