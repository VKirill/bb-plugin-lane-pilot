#!/usr/bin/env python3
"""IndexNow push after a release: validate, dedupe and batch changed URLs, then (only with --go) submit.

Protocol: POST JSON {host, key, keyLocation, urlList} to an IndexNow endpoint; one host per request,
up to 10 000 URLs per request; the key file must be served at keyLocation (or /<key>.txt).
Without --go the script only plans (no network, the key is never printed).

Credentials: the key comes from the environment only — INDEXNOW_KEY (or the variable named by
--key-env). Endpoints: indexnow (api.indexnow.org, shared with Bing/Seznam/Naver/Yep), yandex
(yandex.com/indexnow).

Input JSON: {"host": "site.ru", "key_location": "https://site.ru/<key>.txt" (optional),
             "urls": ["https://site.ru/a/", ...]}
Output JSON: mode (plan|live), accepted[], rejected[{url, reason}], batches[{size}], results[],
             key_present, verdict.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

NAME = "indexnow_push.py"
VERSION = "1.0.0"
ENDPOINTS = {"indexnow": "https://api.indexnow.org/indexnow", "yandex": "https://yandex.com/indexnow"}
MAX_BATCH = 10000
KEY_RE = re.compile(r"^[A-Za-z0-9-]{8,128}$")
CODES = {200: "ok", 202: "accepted (key validation pending)", 400: "bad request", 403: "key not valid",
         422: "urls do not belong to host or key mismatch", 429: "too many requests"}


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


FIXTURE = {"host": "example.ru", "urls": [
    "https://example.ru/catalog/sofas/", "https://example.ru/catalog/sofas/", "https://example.ru/blog/how-to-choose/",
    "https://other.ru/page/", "ftp://example.ru/file", "https://example.ru/catalog/sofas/#reviews",
    "https://www.example.ru/about/"]}


def norm_host(h):
    return (h or "").lower().strip().rstrip(".")      # exact host: www.site.ru is another host for IndexNow


def validate(urls, host):
    accepted, rejected, seen = [], [], set()
    for raw in urls:
        u = str(raw).strip()
        p = urllib.parse.urlsplit(u)
        if p.scheme not in ("http", "https") or not p.netloc:
            rejected.append({"url": u, "reason": "not an absolute http(s) URL"})
            continue
        if norm_host(p.hostname) != norm_host(host):
            rejected.append({"url": u, "reason": "host differs from %s (one host per request)" % host})
            continue
        clean = urllib.parse.urlunsplit((p.scheme, p.netloc.lower(), p.path or "/", p.query, ""))
        if clean in seen:
            rejected.append({"url": u, "reason": "duplicate"})
            continue
        seen.add(clean)
        accepted.append(clean)
    return accepted, rejected


def post(endpoint, payload, timeout):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST",
                                 headers={"Content-Type": "application/json; charset=utf-8",
                                          "User-Agent": "lane-pilot-scripts/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, OSError) as exc:
        return "network: %s" % exc


def compute(data, args):
    host = data["host"]
    accepted, rejected = validate(data["urls"], host)
    key = os.environ.get(args.key_env)
    key_ok = bool(key and KEY_RE.match(key))
    batches = [accepted[i:i + MAX_BATCH] for i in range(0, len(accepted), MAX_BATCH)]
    endpoint = ENDPOINTS[args.endpoint]
    out = {"host": host, "endpoint": endpoint, "accepted": accepted, "rejected": rejected,
           "batches": [{"index": i, "size": len(b)} for i, b in enumerate(batches)],
           "key_present": key_ok, "key_env": args.key_env, "results": []}
    if not args.go or args.fixture:
        warn = [] if key_ok else ["%s is not set or malformed: --go will refuse" % args.key_env]
        out.update({"mode": "plan", "warnings": warn, "verdict": "planned" if accepted else "nothing_to_push"})
        return out
    if not key_ok:
        fail("missing_credentials", "set %s (8-128 chars of [A-Za-z0-9-]) in the environment" % args.key_env, 2)
    loc = data.get("key_location") or "https://%s/%s.txt" % (host, key)
    for i, batch in enumerate(batches):
        code = post(endpoint, {"host": host, "key": key, "keyLocation": loc, "urlList": batch}, args.timeout)
        out["results"].append({"index": i, "status": code, "meaning": CODES.get(code, "unexpected")})
    good = all(r["status"] in (200, 202) for r in out["results"])
    out.update({"mode": "live", "verdict": "pushed" if good else "failed"})
    if not good:
        emit({"ok": False, "script": NAME, "version": VERSION, **out,
              "error": {"code": "push_failed", "message": "an IndexNow batch was not accepted"}})
        sys.exit(1)
    return out


def main():
    ap = Parser(prog=NAME, description="Validate and push changed URLs to IndexNow (plan by default).")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample (plan only)")
    ap.add_argument("--go", action="store_true", help="actually POST to the endpoint")
    ap.add_argument("--endpoint", choices=sorted(ENDPOINTS), default="indexnow")
    ap.add_argument("--key-env", default="INDEXNOW_KEY", help="environment variable holding the key")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
