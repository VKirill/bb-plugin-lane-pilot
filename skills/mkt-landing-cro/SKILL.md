---
name: mkt-landing-cro
description: "Read-only conversion audit of a paid landing, paywall or bot first screen: speed signals, first-screen capture at 375×812 and desktop, offer clarity, friction and trust gaps, the form, and the ad-to-landing message match (stems, price, erid); ranked A/B hypotheses become design, copy and code-task hand-offs. Use when: CRO, конверсия лендинга, первый экран, отказы с рекламы, форма записи, message match, «трафик идёт, а заявок нет». SKIP: ranking/snippet refresh of a search page (seo-page-templates); test statistics (mkt-ab-mde-alerts); a general product UI review (ui-review)."
---

# Landing CRO and message match

Used by `mkt-landing-cro-audit`, by `sp.message_match` in the channel graphs and by `mkt-direct-search-campaign`.
The audit never edits the page. A variant is a writer task in a branch; it goes live only after the message match passes.

## When / do / when not

| When | Do | When not |
|---|---|---|
| Paid traffic converts badly, mobile bounce high | Steps 1–6 | Tracking unhealthy → `mkt-end-to-end-analytics` first |
| An ad, H1 or offer changes | Message match before the change is committed | Decorative change without text, price or URL change |
| Map / call clicks look like bounces | Check the event mix first («маршрут», «звонок» are conversions) | Do not «fix» the landing for map traffic |

## Procedure

1. **Speed.** `python3 scripts/cro_speed_signals.py --input lab.json` → LCP, CLS, INP, TTFB, weight per device.
2. **Capture.** First screen at 375×812 and 1440×900 (browser-automation); what is visible without scrolling.
3. **Clarity.** Five-second read: what is offered, for whom, price, next step. Missing item = a loss row.
4. **Friction and trust.** Form fields, steps, proof (reviews, licences, cases) checked against brandcore claims.
5. **Message match.** `python3 scripts/message_match.py --ads ads.json --capture capture.json --require-erid` → per-ad score,
   price mismatch, missing erid. Passed ads go to the Jev first-screen check in `sp.message_match`.
6. **Loss map.** Rank hypotheses by (traffic share × loss × confidence); top 3 become hand-offs: copy, design, one code task.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| MATCH | stem overlap of keyword ∪ title ∪ text vs H1 ∪ title ∪ first screen ≥ 0.5 | mismatch row |
| PRICE | every price in the ad equals a price on the first screen | block the ad or the change |
| ERID | ORD marker present on every ad | block launch |
| JEV | first-screen promise check p ≥ 0.75 pass, ≤ 0.3 block, between = report | — |
| CLAIMS | a variant that changes price, legal text or a guarantee needs `owner_go == approve` | keep other hand-offs only |
| LOCK | the landing holds a `paid_landing` / `ab_experiment` lock: URL, H1, offer edits only through a joint plan | `queued_conflict` |
| SPEED | LCP mobile ≤ 2.5 s, CLS ≤ 0.1 before blaming the offer | speed task first |

## Output contract

`cro_path` (loss map with evidence), `screens_path`, `message_match.report_path` (`min_score`, `mismatches`, `price_mismatch`),
`needs_owner_go`, `orders[]` (copy-lead, design-lead, writer code task for a variant branch with browser QA).

## Scripts

| Script | Job |
|---|---|
| `scripts/cro_speed_signals.py` | speed signals per device |
| `scripts/message_match.py` | deterministic ad ↔ landing match: stems, price, erid (`--selftest`) |

One JSON object per run, non-zero exit with a JSON error. `--help` first.

## References

- `references/offer-friction-trust.md` — offer, friction, trust scoring and A/B hypothesis ranking.

## Never

- Never edit the live landing from the audit.
- Never let a variant change a price or a promise of an active ad without the joint plan.
- Never count «route» or «call» clicks as bounces.
