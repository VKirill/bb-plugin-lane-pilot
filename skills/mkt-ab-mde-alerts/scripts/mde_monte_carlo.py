#!/usr/bin/env python3
"""MDE / sample size with Monte Carlo power, Beta cold-start priors and an mSPRT + futility boundary.

Distilled from the Karpov «Sample size / MDE» lesson (compute_sample_size, simulated t-tests, A/A
false-positive check) and the Council fixes:
  * S-07 cold start: p0 = 0 gives an infinite sample and blocks launch forever. A Beta(alpha0, beta0)
    prior from the industry CR (effective size alpha0+beta0 <= 20) stabilizes p0, and a micro-conversion
    ladder (target -> activation -> engagement) computes the MDE on the FIRST step with conversions > 0;
    zero steps are reported as "unmeasured", never divided by;
  * D-01 / §6.3 peeking: the boundary is fixed before start (boundary_json): mSPRT (normal mixture,
    tau = absolute MDE) rejects H0 when Lambda >= 1/alpha at any look; futility when the conditional
    power under the current trend < 0.1 at looks >= 2 (release_reason = "boundary").
Simulation is stdlib (random.Random(seed): identical on every host); --engine numpy is optional.

Input JSON: {"alpha": 0.05, "power": 0.8, "mde_rel": 0.15, "sims": 2000, "seed": 42,
             "ladder": [{"step", "visitors", "conversions"}] | "baseline": {"visitors", "conversions"},
             "prior": {"cr": 0.02, "strength": 20}  (target step; a step may carry prior_cr/prior_strength),
             "max_looks": 10,
             "looks": [{"n_a", "x_a", "n_b", "x_b"}]}
Output JSON: chosen_step, p0, p0_source, cold_start, ladder[], n_per_arm, mde_abs, power_analytic,
             power_sim, aa_fpr_sim, boundary_json{}, looks[], decision, release_reason.
"""
import argparse
import json
import math
import random
import sys

NAME = "mde_monte_carlo.py"
VERSION = "1.0.0"
MAX_PRIOR_STRENGTH = 20.0


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
    "alpha": 0.05, "power": 0.8, "mde_rel": 0.2, "sims": 1000, "seed": 42, "max_looks": 6,
    "ladder": [{"step": "payment", "visitors": 2400, "conversions": 0},
               {"step": "trial_activated", "visitors": 2400, "conversions": 192, "prior_cr": 0.07, "prior_strength": 40},
               {"step": "signup", "visitors": 2400, "conversions": 610}],
    "prior": {"cr": 0.06, "strength": 40},
    "looks": [{"n_a": 900, "x_a": 72, "n_b": 900, "x_b": 70},
              {"n_a": 1800, "x_a": 146, "n_b": 1800, "x_b": 138}],
}


def norm_cdf(x):
    return 0.5 * math.erfc(-x / math.sqrt(2))


def norm_ppf(p):
    if not 0 < p < 1:
        raise ValueError("probability must be in (0, 1)")
    lo, hi = -12.0, 12.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if norm_cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def n_two_prop(p1, p2, alpha, power):
    za, zb = norm_ppf(1 - alpha / 2), norm_ppf(power)
    pbar = (p1 + p2) / 2
    num = za * math.sqrt(2 * pbar * (1 - pbar)) + zb * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    return int(math.ceil(num * num / (p2 - p1) ** 2))


def power_analytic(p1, p2, n, alpha):
    se = math.sqrt(p1 * (1 - p1) / n + p2 * (1 - p2) / n)
    return norm_cdf(abs(p2 - p1) / se - norm_ppf(1 - alpha / 2))


def binom(rng, n, p):
    """Deterministic stdlib binomial: normal approximation when np(1-p) >= 25, else geometric skips."""
    if p <= 0:
        return 0
    if p >= 1:
        return n
    var = n * p * (1 - p)
    if var >= 25:
        u1, u2 = rng.random() or 1e-12, rng.random()
        g = math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)
        return max(0, min(n, int(round(n * p + g * math.sqrt(var)))))
    k, pos, lq = 0, 0, math.log(1 - p)
    while True:
        pos += int(math.log(rng.random() or 1e-12) / lq) + 1
        if pos > n:
            return k
        k += 1


def ztest_p(xa, xb, n):
    pa, pb = xa / n, xb / n
    pool = (xa + xb) / (2 * n)
    se = math.sqrt(2 * pool * (1 - pool) / n)
    return 1.0 if se == 0 else math.erfc(abs(pb - pa) / se / math.sqrt(2))


def simulate(p1, p2, n, alpha, sims, seed, engine):
    if engine == "numpy":
        try:
            import numpy as np
        except ImportError:
            engine = "stdlib"
        else:
            rng = np.random.default_rng(seed)
            xa, xb = rng.binomial(n, p1, sims), rng.binomial(n, p2, sims)
            return sum(1 for a, b in zip(xa.tolist(), xb.tolist()) if ztest_p(a, b, n) < alpha) / sims, "numpy"
    rng = random.Random(seed)
    hits = sum(1 for _ in range(sims) if ztest_p(binom(rng, n, p1), binom(rng, n, p2), n) < alpha)
    return hits / sims, "stdlib"


def choose_p0(data):
    ladder = data.get("ladder") or ([dict(data["baseline"], step="target")] if data.get("baseline") else None)
    if not ladder:
        raise ValueError("pass ladder[] or baseline{}")
    prior = data.get("prior") or {}
    capped = False

    def beta(step, index):
        """Prior for a step: its own prior_cr, else the global prior on the target (first) step only."""
        nonlocal capped
        cr = step.get("prior_cr", prior.get("cr") if index == 0 else None)
        if cr is None:
            return None
        cr, s = float(cr), float(step.get("prior_strength", prior.get("strength", MAX_PRIOR_STRENGTH)))
        if not 0 < cr < 1:
            raise ValueError("prior cr must be in (0, 1)")
        capped = capped or s > MAX_PRIOR_STRENGTH
        s = min(s, MAX_PRIOR_STRENGTH)
        return cr * s, (1 - cr) * s

    status, chosen = [], None
    for i, st in enumerate(ladder):
        n, x = int(st["visitors"]), int(st["conversions"])
        measured = x > 0 and n > 0
        status.append({"step": st["step"], "visitors": n, "conversions": x, "status": "measured" if measured else "unmeasured",
                       "observed_rate": round(x / n, 6) if n else None})
        if measured and chosen is None:
            chosen = (i, st)
    if chosen is not None:
        i, st = chosen
        n, x = int(st["visitors"]), int(st["conversions"])
        ab = beta(st, i)
        if ab:
            return st["step"], (ab[0] + x) / (ab[0] + ab[1] + n), "posterior", False, status, ab + (capped,)
        return st["step"], x / n, "observed", False, status, (0.0, 0.0, capped)
    ab = beta(ladder[0], 0)
    if not ab:
        raise ValueError("p0 = 0 on every ladder step and no prior: add prior {cr, strength}")
    tgt = ladder[0]
    p0 = (ab[0] + int(tgt["conversions"])) / (ab[0] + ab[1] + int(tgt["visitors"]))
    return tgt["step"], p0, "prior_only", True, status, ab + (capped,)


def msprt(look, tau):
    na, nb = int(look["n_a"]), int(look["n_b"])
    n = min(na, nb)
    pa, pb = int(look["x_a"]) / na, int(look["x_b"]) / nb
    v = pa * (1 - pa) + pb * (1 - pb)
    if v <= 0:
        return pa, pb, n, 1.0, 0.0, v
    d = pb - pa
    t2 = tau * tau
    lam = math.sqrt(v / (v + n * t2)) * math.exp(min(700.0, n * n * t2 * d * d / (2 * v * (v + n * t2))))
    z = d / math.sqrt(v / n)
    return pa, pb, n, lam, z, v


def compute(data, args):
    alpha, power = float(data.get("alpha", 0.05)), float(data.get("power", 0.8))
    mde_rel = float(data.get("mde_rel", 0.1))
    sims, seed = int(args.sims or data.get("sims", 2000)), int(data.get("seed", 42))
    step, p0, src, cold, ladder, (a0, b0, capped) = choose_p0(data)
    p1 = p0 * (1 + mde_rel)
    if not 0 < p1 < 1:
        raise ValueError("p0 * (1 + mde_rel) must stay in (0, 1)")
    n = n_two_prop(p0, p1, alpha, power)
    pw, engine = simulate(p0, p1, n, alpha, sims, seed, args.engine)
    fpr, _ = simulate(p0, p0, n, alpha, sims, seed + 1, args.engine)
    tau = abs(p1 - p0)
    boundary = {"type": "mSPRT+futility", "alpha": alpha, "tau": round(tau, 8), "threshold_lambda": round(1 / alpha, 6),
                "futility_conditional_power": 0.1, "futility_min_looks": 2, "n_required_per_arm": n,
                "max_looks": int(data.get("max_looks", 10)), "frozen_at_start": True}
    looks, decision, reason = [], "not_started", None
    za = norm_ppf(1 - alpha / 2)
    for i, lk in enumerate(data.get("looks") or [], start=1):
        pa, pb, nn, lam, z, _ = msprt(lk, tau)
        t = min(nn / n, 0.999)
        cp = 1 - norm_cdf((za - z / math.sqrt(t)) / math.sqrt(1 - t)) if z > -50 else 0.0
        row = {"look": i, "n_per_arm": nn, "rate_a": round(pa, 6), "rate_b": round(pb, 6), "z": round(z, 4),
               "lambda": round(lam, 6), "info_fraction": round(t, 4), "conditional_power": round(cp, 4)}
        if lam >= 1 / alpha:
            row["decision"], decision, reason = "reject_null", "reject_null", "boundary"
        elif i >= 2 and cp < 0.1:
            row["decision"], decision, reason = "stop_futility", "stop_futility", "boundary"
        elif nn >= n or i >= boundary["max_looks"]:
            row["decision"], decision, reason = "stop_no_effect", "stop_no_effect", "horizon"
        else:
            row["decision"], decision = "continue", "continue"
        looks.append(row)
        if row["decision"] != "continue":
            break
    warnings = ["prior strength capped at %.0f (effective size)" % MAX_PRIOR_STRENGTH] if capped else []
    if cold:
        warnings.append("cold start: p0 comes from the prior only; re-run after first conversions")
    return {"chosen_step": step, "p0": round(p0, 6), "p0_source": src, "cold_start": cold, "ladder": ladder,
            "prior": {"alpha0": round(a0, 4), "beta0": round(b0, 4)}, "mde_rel": mde_rel, "mde_abs": round(tau, 8),
            "n_per_arm": n, "power_target": power, "power_analytic": round(power_analytic(p0, p1, n, alpha), 4),
            "power_sim": round(pw, 4), "aa_fpr_sim": round(fpr, 4), "sims": sims, "seed": seed, "engine": engine,
            "boundary_json": boundary, "looks": looks, "decision": decision, "release_reason": reason,
            "warnings": warnings}


def main():
    ap = Parser(prog=NAME, description="Sample size / MDE with Monte Carlo power, Beta priors and mSPRT futility.")
    ap.add_argument("--input", help="JSON input file, - for stdin")
    ap.add_argument("--fixture", action="store_true", help="run on the built-in offline sample")
    ap.add_argument("--sims", type=int, help="Monte Carlo simulations (default: input sims or 2000)")
    ap.add_argument("--engine", choices=["stdlib", "numpy"], default="stdlib",
                    help="simulation engine; numpy falls back to stdlib when not installed")
    args = ap.parse_args()
    data = load_input(args, FIXTURE)
    try:
        result = compute(data, args)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        fail("invalid_data", "%s: %s" % (type(exc).__name__, exc), 2)
    emit({"ok": True, "script": NAME, "version": VERSION, **result})


if __name__ == "__main__":
    main()
