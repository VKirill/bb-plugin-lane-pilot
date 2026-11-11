---
name: mkt-ab-mde-alerts
description: "Experiment and alert math for marketing: MDE and sample size by Monte Carlo with Beta cold-start priors, a fixed-horizon or mSPRT sample lock with a futility boundary, deterministic bucketing, robust MAD z-score anomalies with Benjamini–Hochberg FDR, and forecast corridors. Use when: A/B тест, MDE, размер выборки, замок выборки, подглядывание, аномалии метрик, алерты, коридор прогноза, «тест уже значим?». SKIP: tracking repair and unit economics (mkt-end-to-end-analytics); building the ads themselves (mkt-telegram-ads-method, mkt-yandex-direct-epk); SEO cohort tests (seo-measurement-loop)."
---

# A/B, MDE and alerts

Used by `mkt-experiment-cycle` (design and evaluate), `mkt-pulse-monitor` (alerts, corridors, sample readiness) and
`lp.specialist-eval` (forecast scoring). The decision rule is written **before** launch; the evaluate phase only reads it.

## When / do / when not

| When | Do | When not |
|---|---|---|
| A hypothesis is ready to test | MDE → feasibility → bucketing → lock | The cell cannot reach MDE inside budget and horizon → `cell_below_mde`, no test |
| A running test asks «can we call it?» | Read the lock: fixed horizon or mSPRT boundary | A daily peek on a fixed-horizon lock → answer «not yet», never a verdict |
| A metric jumped | Robust z on the same weekday, BH over all checks of the tick | Tracking unhealthy or a RU holiday window → no anomaly |

## Procedure

1. **MDE.** `python3 scripts/mde_monte_carlo.py --input plan.json` → `n_required`, power curve; on `p0 = 0` it uses a
   `Beta(α0, β0)` prior from the sector CR (prior weight ≤ 20) and the first micro-conversion rung where `p0 > 0`.
2. **Feasibility.** Minimum viable cell = `cpa_est · n_required / horizon_days`. Bigger than the test budget → stop.
3. **Bucketing.** `python3 scripts/bucketing_split.py --input units.json` → deterministic hash split, SRM check on the first day.
4. **Lock.** Write `n_required`, `max_looks`, the boundary (fixed horizon **or** mSPRT with futility), `max_spend`, `max_duration`.
5. **Alerts.** `python3 scripts/product_alerts.py --input series.json` → robust z per metric, BH-adjusted list.
6. **Forecast.** `python3 scripts/metric_forecast.py --input history.json` → `{point, lo80, hi80, horizon_days}` corridor.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| PRE-REG | metric, unit, baseline, MDE, α = 0.05, power = 0.8, ≥ 2 full weeks written before launch | no launch |
| FEASIBLE | minimum cell ≤ cell budget and ≤ `auto_test_cell_cap` | `cell_below_mde` |
| PEEK | fixed horizon: verdict only at `events ≥ n_required`; mSPRT: only on its boundary | `not_ready` |
| SRM | sample ratio mismatch p < 0.001 | block the causal verdict |
| ANOMALY | `|z| ≥ 3.5`, z = (x − median) / (1.4826 · MAD) on 8 same-weekday points | not an anomaly |
| FDR | Benjamini–Hochberg q = 0.10 across every check of the tick | drop it from alerts |
| CONTEXT | `tracking_health_ok` and not a RU holiday / sale window | suppress, note the reason |
| CELLS | concurrent test cells ≤ `max_concurrent_test_cells`; auto spend ≤ rolling 24 h cap | reservation refused |
| FORECAST | a forecast without `lo80/hi80` is not scored | reject |

## Output contract

`plan_path` with the lock spec (`n_required`, boundary, caps), `readiness` (0..1), `decision ∈ scale | kill | extend | inconclusive`,
`anomalies[]` (metric, z, q, context flags), `corridor_json`, `learning` (one line for memory).

## Scripts

| Script | Job |
|---|---|
| `scripts/mde_monte_carlo.py` | MDE, sample size, Beta priors, mSPRT and futility boundary |
| `scripts/bucketing_split.py` | deterministic split and SRM |
| `scripts/product_alerts.py` | robust MAD z-score anomalies with BH FDR |
| `scripts/metric_forecast.py` | point forecast with an 80 % interval |

One JSON object per run, non-zero exit with a JSON error. `--help` first, `--fixture` to dry-run.

## References

- `references/experiment-math.md` — MDE, CUPED, bucketing, sequential tests.
- `references/alerts-forecasting.md` — product alert rules and forecasting.

## Never

- Never call a winner from a peek on a fixed-horizon lock.
- Never split a small budget 70/20/10 when the 10 % cell cannot reach MDE.
- Never treat Direct showing two ads as a randomized A/B test.
