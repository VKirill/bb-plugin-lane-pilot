---
name: mkt-end-to-end-analytics
description: "End-to-end marketing analytics: unit economics (margin, LTV, max CAC, payback with an immature-cohort mask), UTM and start= validation, Metrika/GA4/GTM event contract, CRM and server-to-server conversions, and a reconcile of analytics against payments in the database. Use when: сквозная аналитика, юнит-экономика, CAC/ROMI, UTM, офлайн-конверсии, расхождение Метрики и базы, «оплаты без источника», dataLayer. SKIP: A/B math and alerts (mkt-ab-mde-alerts); Direct campaign build (mkt-yandex-direct-epk); site crawl/indexation (seo-tech-audit-kit)."
---

# End-to-end analytics and unit economics

Used by `mkt-project-intake` (unit economics), `mkt-tracking-setup` (UTM, events, reconcile) and `mkt-pulse-monitor`
(tracking health). Analytics is read through read-only MCP servers (`mcp-yandex-seo-ro`, `mcp-ga4-ro`, `mcp-gtm-ro`).
A goal, tag or event change is a live mutation: it goes through `owner_go` and `sp.apply_mutation`, never from here.

## When / do / when not

| When | Do | When not |
|---|---|---|
| Cold start or a new channel | Unit economics: margin, LTV, max CAC, payback window | No margin fact yet → owner question with a safe default marked guess |
| Payments have no source, or analytics ≠ database | UTM/start= check, then reconcile | A single-day gap ≤ 10 % → noise, note it |
| Before any stop-loss on CAC | Apply the cohort maturity mask | Spend cap exhausted → the safety stop still fires (breaker) |

## Procedure

1. **Unit economics.** `python3 scripts/unit_economics_check.py --input unit_econ.json` → `max_cac`, `payback_days`,
   `maturity_window_days` (P90 click → payment), and the `assumption_ids[]` each number depends on.
2. **Tracking inventory** (read-only): Metrika goals, GA4 key events, GTM tags; list what the funnel needs and is missing.
3. **UTM and deep links.** `python3 scripts/utm_validator.py --input links.json` → malformed, missing, colliding UTM and start= codes.
4. **Reconcile.** `python3 scripts/funnel_reconcile.py --input funnel.json` → analytics vs database per day and channel, gap share,
   unattributed share, verdict `tracking_health_ok`.
5. **Event contract.** Write the dataLayer contract (event, params, trigger, owner) and one writer code task for missing events.
6. **Live changes** (goals, GTM publish, GA4 key events) become a change plan for `owner_go`; rollback receipts are written first.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| COHORT mask | CAC/ROMI for a stop or cut uses only cohorts with `clickAt ≤ now − max(14 d, Lconv95 + Lingest99) − 1 d` | verdict `pending_maturity`, no performance stop |
| MATURE floor | without history the maturity is 14 + 1 days, a minimum, never a ceiling; Metrika/CRM lag 7–14 d is inside it | — |
| HEALTH | analytics vs database gap ≤ 10 % over 7 days | `tracking_outage`: freeze performance decisions, order `mkt-tracking-setup` |
| ASSUMPTION | a money decision whose result flips when one `safe_default` moves ±20 % | `paused_pending_owner_fact` |
| DISCOUNT | combined discount `1 − sqrt(Σ w·δ²) ≥ 0.65`, never a product of discounts | recompute |
| UNKNOWN join | a payment without a join id stays `unknown`, never the last channel | — |
| LIVE | any goal/tag/event change → `owner_go == approve` + code-minted token | keep it as a code task |

## Output contract

`telemetry_map_path`, `reconcile.report_path`, `unit_econ_path` with `max_cac`, `payback_days`, `maturity_window_days`,
`assumption_ids[]`, `tracking_health_ok`, and `orders[]` (code tasks for events; live changes as a plan for the gate).

## Scripts

| Script | Job |
|---|---|
| `scripts/unit_economics_check.py` | margin, LTV, max CAC, payback, immature-cohort mask |
| `scripts/utm_validator.py` | UTM and start= link check |
| `scripts/funnel_reconcile.py` | analytics vs database by day and channel |

One JSON object per run, non-zero exit with a JSON error. `--help` first, `--fixture` to dry-run.

## References

- `references/architecture-unit-economics.md` — the analytics architecture, unit economics and CJM.
- `references/tracking-ga4-gtm-utm-s2s.md` — GA4, GTM dataLayer, UTM rules, server-to-server conversions.
- `references/reconciliation.md` — warehouse joins, reconcile and report checks.

## Never

- Never cut a campaign on a cohort younger than its maturity window.
- Never write a goal, tag or event live from an agent step.
- Never put a guessed margin into `max_cac` without its assumption id.
