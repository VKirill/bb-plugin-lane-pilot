---
name: mkt-yandex-direct-epk
description: >-
  Method for Yandex Direct unified performance campaigns (ЕПК, API v501): keyword clusters and cross-negatives, RESPONSIVE_AD headline × text combinatorics pre-mortem, Ogilvy/Bly/Sugarman ad copy gates, ORD erid marking, autotargeting control, offline conversion goals, strategy choice, the ≤15 % / 120 h learning guard, and the SEO × PPC query bridge. Use when: Яндекс Директ, ЕПК, поисковая кампания, минус-слова, автотаргетинг, стратегия «оплата за конверсии», ОРД, мост SEO × Директ. SKIP: Telegram Ads (mkt-telegram-ads-method); landing conversion audit (mkt-landing-cro); campaign-level A/B statistics (mkt-ab-mde-alerts).
---

# Yandex Direct ЕПК

Used by `mkt-direct-search-campaign` and by the marketing shift. Cabinet data is read through `mcp-yandex-seo-ro`.
Any create, edit or budget change is a change set for `owner_go` → `sp.apply_mutation` (tier L, code-minted HMAC token,
`strategyGuard`). Nothing in this skill calls a write tool.

## When / do / when not

| When | Do | When not |
|---|---|---|
| New or rebuilt ЕПК | Clusters → negatives → ads → combinatorics lint → bridge → change set | No conversion goal in Metrika yet → `mkt-end-to-end-analytics` first |
| Query report shows waste | Search-term mining, negatives, autotargeting categories | A single day of noise; wait for 7 days of terms |
| Strategy or budget change | Check the learning guard, then plan | Last edit < 120 h ago → wait (breaker cuts are the only exception) |

## Procedure

1. **Read state** (read-only): campaigns, strategy, `PriorityGoals`, `ADD_METRICA_TAG`, autotargeting share, search terms 30 d.
2. **Clusters.** Group demand by intent; one ad group per intent; commercial and informational never mixed.
3. **Negatives.** Cross-negatives between groups; terms with spend and 0 conversions over 30 d; competitor addresses.
4. **Bridge.** `python3 scripts/seo_ppc_bridge.py --input bridge_in.json` → queries where organic is top-3 with CTR ≥ 0.3
   (paid bid down or negative), paid converters missing in SEO (handed to the SEO specialist), shared negatives.
5. **Ads (*Ogilvy + Bly + Sugarman Copy Gate*).** 3–7 headlines (`<=56` chars) × 2–3 texts (`<=81` chars) per group, erid on every ad, price and geo equal to the landing:
   - *Ogilvy Factual Specificity*: pack headlines with concrete numbers, SLA deadlines, or price floor (`от X ₽`) — zero empty epithets («высокое качество», «лучшие условия»);
   - *Bly `Feature -> Benefit`*: every text translates technical capability into tangible buyer payoff (hours/money saved or risk removed; split B2B `payer` ROI vs `user` speed);
   - *Sugarman Curiosity / Slippery-Slide Bridge*: close texts with a concrete low-friction hook (e.g., «Смета по VIN за 5 минут на сайте») matching the landing's first sentence.
6. **Pre-mortem.** `python3 scripts/epk_combinatorics_lint.py --input ads.json` → every headline × text pair checked for
   tautology, contradiction, length, missing erid; the ad–landing message match runs in `sp.message_match`.
7. **Change set.** A v501 diff with the daily budget, strategy, goals, rollback; it waits for `owner_go`.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| GOAL | the strategy optimises a booking/payment goal present in `PriorityGoals`, not «engaged sessions» | fix goals first |
| YCLID | `ADD_METRICA_TAG = YES` for offline conversions | add to the change set |
| AUTOTARGET | autotargeting > 50 % of spend in a search campaign with CPA above target → narrow categories | change set item |
| COMBO | every RESPONSIVE_AD pair passes the lint (0 bad pairs) | rework ads |
| ERID | every ad carries ORD marking | block launch |
| MATCH | message match ≥ 0.5 and equal price per ad group | rework ad or hand to CRO |
| LEARN | strategy/budget/tCPA step ≤ 15 % and ≥ 120 h since the last edit (breaker decreases exempt) | refuse the edit |
| LAG | no performance cut on cohorts younger than the maturity window (7–14 d CRM lag) | wait |
| SPEND | live spend = 0 until an approved envelope; rolling 24 h auto cap and concurrent cells respected | reservation refused |
| LANDING LOCK | the landing URL gets a `paid_landing` lock while ads point to it; SEO URL/H1 changes need a joint plan | — |

## Output contract

`campaign_path` (clusters, negatives, ads, strategy), `bridge_path`, `premortem` report, `change_set` (v501 diff + rollback),
`spend_eur`, `needs_owner_go`, `orders[]` (SEO hand-offs, CRO audit).

## Scripts

| Script | Job |
|---|---|
| `scripts/epk_combinatorics_lint.py` | headline × text pre-mortem, erid, ≤ 15 % / 120 h guard check of the plan |
| `scripts/seo_ppc_bridge.py` | SEO × PPC query bridge and shared negatives |

One JSON object per run, non-zero exit with a JSON error. `--help` first, `--fixture` to dry-run.

## References

- `references/campaigns-v501.md` — ЕПК structure in API v501, autotargeting and placements.
- `references/bidding-conversions-ord.md` — strategies, offline conversions, negatives, ORD marking, pacing.

## Never

- Never edit a live campaign from an agent step; only the gated executor writes.
- Never move a strategy more than 15 % or twice inside 120 h.
- Never judge CPA on the cabinet's own conversions when Metrika booking goals disagree; reconcile first.
