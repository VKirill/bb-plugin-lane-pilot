#!/usr/bin/env python3
"""Content-factory batch handoff: Council S-06 stage 3 — canary batching gated by indexation of the previous batch.

Checked in code before a `content_batch` is handed to `bb cf`:
  * every URL must have passed stages 1-2 (decision publish_candidate, serp_overlap < 0.40,
    unique_verified_facts >= 3) — re-verified here, never trusted blindly;
  * no previous batch: the first (canary) batch is at most 15 URLs;
  * previous batch younger than 14 days: wait (drafts may still be created, nothing is published);
  * previous batch indexation_rate_14d >= 0.65: release the next batch (doubling, capped by next_batch_max);
  * otherwise: content_batch is FROZEN and a seo-structure-audit task is emitted.
Drafts are always allowed («content_factory_brief_batches: create drafts freely»), publication is gated.

Input JSON: {"as_of": "YYYY-MM-DD", "candidates": [{"id", "url", "decision", "serp_overlap", "unique_verified_facts", "frequency"}],
             "batches": [{"batch_id", "published_at", "urls": [], "indexed": [] | "indexation_rate_14d": 0.7}],
             "first_batch_max": 15, "next_batch_max": 60, "min_indexation": 0.65, "min_age_days": 14}
Output JSON: status (release|wait|frozen|nothing_to_release), batch{batch_id, urls[], mode}, rejected[],
             previous{}, tasks[], content_batch{} (payload for the content factory).
"""
import argparse
import json
import sys
from datetime import date, timedelta

NAME = "cf_batch_handoff.py"
VERSION = "1.0.0"


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
    "as_of": "2026-11-11",
    "candidates": [{"id": "c%02d" % i, "url": "https://crm.ru/compare/c%02d/" % i, "decision": "publish_candidate",
                    "serp_overlap": 0.1, "unique_verified_facts": 4, "frequency": 1000 - i * 10} for i in range(1, 41)]
    + [{"id": "bad1", "url": "https://crm.ru/compare/bad1/", "decision": "needs_facts", "serp_overlap": 0.2,
        "unique_verified_facts": 1}],
    "batches": [{"batch_id": "b1", "published_at": "2026-10-20",
                 "urls": ["https://crm.ru/compare/p%02d/" % i for i in range(15)],
                 "indexed": ["https://crm.ru/compare/p%02d/" % i for i in range(11)]}],
}


def gate_ok(c, max_ov, min_facts):
    why = []
    if c.get("decision") != "publish_candidate":
        why.append("stage 1-2 decision is %s" % c.get("decision"))
    if c.get("serp_overlap") is None or float(c["serp_overlap"]) >= max_ov:
        why.append("serp_overlap %s >= %.2f" % (c.get("serp_overlap"), max_ov))
    if int(c.get("unique_verified_facts") or 0) < min_facts:
        why.append("unique_verified_facts %s < %d" % (c.get("unique_verified_facts"), min_facts))
    return why


def compute(data, args):
    as_of = date.fromisoformat(args.as_of or data["as_of"])
    first_max = int(data.get("first_batch_max", 15))
    next_max = int(data.get("next_batch_max", 60))
    min_idx = float(data.get("min_indexation", 0.65))
    min_age = int(data.get("min_age_days", 14))
    max_ov, min_facts = float(data.get("max_overlap", 0.40)), int(data.get("min_facts", 3))
    published = {u for b in data.get("batches") or [] for u in b.get("urls") or []}
    ready, rejected = [], []
    for c in sorted(data["candidates"], key=lambda x: (-float(x.get("frequency") or 0), str(x["id"]))):
        why = gate_ok(c, max_ov, min_facts)
        if c.get("url") in published:
            why.append("already published")
        (rejected.append({"id": c["id"], "url": c.get("url"), "reasons": why}) if why else ready.append(c))
    batches = sorted(data.get("batches") or [], key=lambda b: b["published_at"])
    prev, tasks = None, []
    if not batches:
        status, size = "release", first_max
    else:
        last = batches[-1]
        pub = date.fromisoformat(last["published_at"])
        age = (as_of - pub).days
        urls = last.get("urls") or []
        rate = last.get("indexation_rate_14d")
        if rate is None:
            rate = len(set(last.get("indexed") or []) & set(urls)) / len(urls) if urls else 0.0
        prev = {"batch_id": last["batch_id"], "published_at": last["published_at"], "age_days": age,
                "size": len(urls), "indexation_rate_14d": round(float(rate), 4)}
        if age < min_age:
            status, size = "wait", 0
            prev["release_not_before"] = (pub + timedelta(days=min_age)).isoformat()
        elif rate >= min_idx:
            status, size = "release", min(next_max, max(first_max, 2 * len(urls)))
        else:
            status, size = "frozen", 0
            tasks.append({"type": "seo-structure-audit", "reason": "indexation_rate_14d %.2f < %.2f for %s" %
                          (rate, min_idx, last["batch_id"]), "blocks": "content_batch"})
    picked = ready[:size] if status == "release" else []
    if status == "release" and not picked:
        status = "nothing_to_release"
    bid = "b%d" % (len(batches) + 1)
    mode = "publish" if picked else "draft"
    return {"as_of": as_of.isoformat(), "status": status, "previous": prev, "tasks": tasks, "rejected": rejected,
            "batch": {"batch_id": bid if picked else None, "urls": [c["url"] for c in picked], "size": len(picked),
                      "mode": mode},
            "content_batch": {"mode": mode, "batch_id": bid if picked else None,
                              "items": [{"id": c["id"], "url": c["url"]} for c in picked],
                              "drafts_allowed": [c["id"] for c in ready[len(picked):]]},
            "thresholds": {"first_batch_max": first_max, "next_batch_max": next_max, "min_indexation": min_idx,
                           "min_age_days": min_age}}


def main():
    ap = Parser(prog=NAME, description="Canary batching for the content factory, gated by indexation_rate_14d.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--as-of", help="decision date YYYY-MM-DD (default: input as_of)")
    ap.add_argument("--strict", action="store_true", help="exit 3 when status is frozen")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})
    if args.strict and result["status"] == "frozen":
        sys.exit(3)


if __name__ == "__main__":
    main()
