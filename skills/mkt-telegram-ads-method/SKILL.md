---
name: mkt-telegram-ads-method
description: "Method for official Telegram Ads campaigns run by the growth marketer: channel and bot pools screened for bot farms, one-to-one ad matrix, start= deep-link attribution, moderation lint, CPM in TON, a sample lock from the MDE and the stop rule. Use when: Telegram Ads, TG Ads, реклама в Телеграм, пулы каналов, start= метки, CPM в TON, модерация объявлений, «объявление даёт клики, но нет оплат». SKIP: executing in the cabinet (telegram-ads / telegram-ads-assistant); paid posts bought from channel admins (seo-linkbuilding-method or outreach); Yandex Direct (mkt-yandex-direct-epk)."
---

# Telegram Ads method

Used by `mkt-tg-ads-campaign`. This skill plans and checks; the cabinet is driven only by the `launch` step after
`owner_go == approve`, in the owner's Telegram Ads session (`telegram-ads` skill).

## When / do / when not

| When | Do | When not |
|---|---|---|
| New campaign or a new offer | Pools → ads → lint → attribution plan → lock → change set | No bot/landing event for the target action → fix tracking first |
| Clicks but no payments | Read start= funnel per ad: click → /start → key event → payment | < 100 clicks on the ad → not enough data |
| CPM or creative change | Check the lock and the stop rule first | Inside a running sample lock without a boundary hit |

## Procedure

1. **Pools.** Channels by topic and audience; screen each for bot farms (views/subscribers, post reach curve, comment quality);
   bots for bot-targeted ads. One-to-one: an ad per channel when the channel is large enough for its own sample.
2. **Ads.** Text within moderation rules (length, no forbidden claims, no external-ad formatting); one promise per ad.
3. **Lint.** `python3 scripts/tg_moderation_lint.py --input ads.json` → rule violations per ad.
4. **Attribution.** Every ad gets its own `start=` code; `python3 scripts/tg_start_attribution.py --input funnel.json`
   → per-ad funnel, junk-start share, cost per payer.
5. **Lock.** Sample size from `mkt-ab-mde-alerts`; write the stop rule (cost per payer ceiling, junk-start ceiling).
6. **Change set.** Ads, pools, CPM, daily cap, stop rule; wait for `owner_go`; a sync check runs on the next tick.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| POOL | channel passes the bot-farm screen | drop the channel |
| MOD | 0 moderation-lint violations | rework the ad |
| CODE | unique `start=` code per ad, resolvable in the bot | block launch |
| JUNK | junk starts (no key event in 24 h) ≤ 40 % of starts after 50 starts | pause the ad (stop rule) |
| PAYER | cost per payer ≤ the charter ceiling after the lock matures | scale stops, ad paused |
| MATCH | ad promise = first message of the bot / landing first screen | rework |
| SPEND | live spend 0 until approved; CPM changes inside the daily cap; rolling 24 h auto cap respected | reservation refused |
| LAG | payment cohort matured (maturity window) before a kill on cost per payer | wait |

## Output contract

`campaign_path` (pools, ads, CPM, codes), `lint_report`, `attribution_report`, `lock_spec`, `spend_eur`, `needs_owner_go`,
`orders[]` (copy rework, CRO of the bot flow).

## Scripts

| Script | Job |
|---|---|
| `scripts/tg_moderation_lint.py` | moderation rule lint per ad |
| `scripts/tg_start_attribution.py` | start= funnel per ad, junk share, cost per payer |

One JSON object per run, non-zero exit with a JSON error. `--help` first, `--fixture` to dry-run.

## References

- `references/cabinets-pools-cpm.md` — cabinets, targeting types, pools, CPM in TON.
- `references/attribution-moderation.md` — start= attribution, creatives, moderation, anti-fraud.

## Never

- Never launch or change bids from this skill; the gated `launch` step does it.
- Never judge an ad on clicks alone; the unit is the payer.
- Never reuse one `start=` code for two ads.
