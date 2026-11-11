#!/usr/bin/env python3
"""Bucketing split: deterministic salted-hash assignment, SRM chi-square check and a bucket-level ratio test.

Distilled from the Karpov A/B lessons: users are split by md5(user_id + salt) % n_buckets (stable,
no state), groups own contiguous bucket ranges by weight; ratio metrics (CTR = clicks/views) are
compared on BUCKET aggregates (sum num / sum den per bucket) so users with many views do not break
the independence assumption, then Welch's t-test runs over the buckets.
SRM (sample ratio mismatch): chi-square of observed group sizes vs the planned weights; p < 0.001
means the split is broken and the experiment must not be read.
All statistics are stdlib (regularized incomplete gamma / beta), identical on every host.

Input JSON: {"salt": "exp_checkout_2026_11", "n_buckets": 100, "groups": {"control": 50, "test": 50},
             "metric": {"num": "clicks", "den": "views"}, "users": [{"user_id", "clicks", "views"}],
             "observed_counts": {"control": n, "test": n} (optional SRM-only mode)}
Output JSON: bucket_ranges{}, counts{}, srm{chi2, df, p, mismatch}, bucket_test{}, sample_assignments[].
"""
import argparse
import hashlib
import json
import math
import random
import sys

NAME = "bucketing_split.py"
VERSION = "1.0.0"
SRM_P = 0.001


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


def _fixture():
    rng = random.Random(7)
    users = []
    for i in range(3000):
        views = 1 + int(rng.expovariate(1 / 12))
        users.append({"user_id": "u%05d" % i, "views": views, "clicks": sum(1 for _ in range(views) if rng.random() < 0.21)})
    return {"salt": "exp_feed_ranking_2026_11", "n_buckets": 100, "groups": {"control": 50, "test": 50},
            "metric": {"num": "clicks", "den": "views"}, "users": users, "treatment_lift": {"test": 0.06}}


FIXTURE = _fixture()


def bucket(user_id, salt, n):
    return int(hashlib.md5((str(user_id) + salt).encode("utf-8")).hexdigest(), 16) % n


def ranges(groups, n):
    total = float(sum(groups.values()))
    out, start, acc = {}, 0, 0.0
    names = list(groups)
    for i, g in enumerate(names):
        acc += groups[g]
        end = n if i == len(names) - 1 else int(round(acc / total * n))
        out[g] = [start, end - 1]
        start = end
    return out


def gammaincc(s, x):
    """Regularized upper incomplete gamma Q(s, x) (Numerical Recipes series / continued fraction)."""
    if x <= 0:
        return 1.0
    gln = math.lgamma(s)
    if x < s + 1:
        term = summ = 1.0 / s
        a = s
        for _ in range(500):
            a += 1
            term *= x / a
            summ += term
            if abs(term) < abs(summ) * 1e-15:
                break
        return max(0.0, 1.0 - summ * math.exp(-x + s * math.log(x) - gln))
    b, c, d = x + 1 - s, 1e300, 1.0 / (x + 1 - s)
    h = d
    for i in range(1, 500):
        an = -i * (i - s)
        b += 2
        d = an * d + b
        d = 1e-300 if abs(d) < 1e-300 else d
        c = b + an / c
        c = 1e-300 if abs(c) < 1e-300 else c
        d = 1.0 / d
        h *= d * c
        if abs(d * c - 1) < 1e-15:
            break
    return math.exp(-x + s * math.log(x) - gln) * h


def betacf(a, b, x):
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1.0 / (1e-300 if abs(d) < 1e-300 else d)
    h = d
    for m in range(1, 500):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        d = 1.0 / (1e-300 if abs(d) < 1e-300 else d)
        c = 1 + aa / c
        c = 1e-300 if abs(c) < 1e-300 else c
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        d = 1.0 / (1e-300 if abs(d) < 1e-300 else d)
        c = 1 + aa / c
        c = 1e-300 if abs(c) < 1e-300 else c
        de = d * c
        h *= de
        if abs(de - 1) < 1e-15:
            break
    return h


def betainc(a, b, x):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1) / (a + b + 2):
        return bt * betacf(a, b, x) / a
    return 1 - bt * betacf(b, a, 1 - x) / b


def t_two_sided_p(t, df):
    return betainc(df / 2, 0.5, df / (df + t * t))


def welch(a, b):
    na, nb = len(a), len(b)
    ma, mb = sum(a) / na, sum(b) / nb
    va = sum((x - ma) ** 2 for x in a) / (na - 1)
    vb = sum((x - mb) ** 2 for x in b) / (nb - 1)
    se2 = va / na + vb / nb
    if se2 == 0:
        return ma, mb, 0.0, float(na + nb - 2), 1.0
    t = (mb - ma) / math.sqrt(se2)
    df = se2 ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1))
    return ma, mb, t, df, t_two_sided_p(t, df)


def compute(data, args):
    salt, n = str(data["salt"]), int(data.get("n_buckets", 100))
    groups = {str(k): float(v) for k, v in data["groups"].items()}
    if len(groups) < 2 or any(v <= 0 for v in groups.values()):
        raise ValueError("need >= 2 groups with positive weights")
    rng_map = ranges(groups, n)
    owner = {b: g for g, (lo, hi) in rng_map.items() for b in range(lo, hi + 1)}
    users = data.get("users") or []
    counts = {g: 0 for g in groups}
    metric = data.get("metric") or {}
    num, den = metric.get("num"), metric.get("den")
    lift = data.get("treatment_lift") or {}
    agg = {}
    sample = []
    for u in sorted(users, key=lambda x: str(x["user_id"])):
        b = bucket(u["user_id"], salt, n)
        g = owner[b]
        counts[g] += 1
        if len(sample) < 20:
            sample.append({"user_id": u["user_id"], "bucket": b, "group": g})
        if num and den:
            k = agg.setdefault((g, b), [0.0, 0.0])
            k[0] += float(u[num]) * (1 + float(lift.get(g, 0)))
            k[1] += float(u[den])
    if not users:
        counts = {g: int(v) for g, v in (data.get("observed_counts") or {}).items()}
        if set(counts) != set(groups):
            raise ValueError("pass users[] or observed_counts for every group")
    total = sum(counts.values())
    wsum = sum(groups.values())
    chi2 = sum((counts[g] - total * w / wsum) ** 2 / (total * w / wsum) for g, w in groups.items()) if total else 0.0
    df = len(groups) - 1
    p_srm = gammaincc(df / 2, chi2 / 2)
    out = {"salt": salt, "n_buckets": n, "bucket_ranges": rng_map, "counts": counts,
           "srm": {"chi2": round(chi2, 4), "df": df, "p": p_srm, "mismatch": p_srm < SRM_P, "threshold": SRM_P},
           "sample_assignments": sample}
    if agg:
        names = list(groups)
        ctrl, test = names[0], names[1]
        per = {g: [v[0] / v[1] for (gg, _), v in sorted(agg.items()) if gg == g and v[1] > 0] for g in names}
        if min(len(per[ctrl]), len(per[test])) < 2:
            raise ValueError("need >= 2 non-empty buckets per group for the test")
        ma, mb, t, dfw, p = welch(per[ctrl], per[test])
        out["bucket_test"] = {"control": ctrl, "test": test, "buckets": {g: len(v) for g, v in per.items()},
                              "mean_control": round(ma, 6), "mean_test": round(mb, 6),
                              "uplift_rel": round((mb - ma) / ma, 6) if ma else None, "t": round(t, 4),
                              "df": round(dfw, 2), "p": p, "readable": not out["srm"]["mismatch"]}
    if args.emit_assignments:
        out["assignments"] = [{"user_id": u["user_id"], "bucket": bucket(u["user_id"], salt, n),
                               "group": owner[bucket(u["user_id"], salt, n)]} for u in users]
    return out


def main():
    ap = Parser(prog=NAME, description="Salted-hash bucketing, SRM check and bucket-level Welch test.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--emit-assignments", action="store_true", help="include every user's bucket and group")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
