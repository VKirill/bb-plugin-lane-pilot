---
name: mkt-organic-content
description: "Method for the organic content contour of the growth marketer: Dzen 2026 articles (feed signals, Channel Bible, fan avatar, headline and cover rules, Telegram bridges), Pinterest 2026 pins as long-tail visual search (profile and board SEO, keyword map, 2:3 visual hierarchy, setup sprint vs daily cadence, UTM routing without spam throttling), Reels scripts (3-second hook, one idea, open loop, pace, one CTA) and native-selling blog posts (trigger dosage, case structure, codeword or bot bridge). Gates every pack with audit_organic_pack.py before the content factory. Use when: Дзен-канал, статья для Дзена, Библия канала, аватар фаната, Pinterest пины, доски, Reels сценарий, хук, рилс не залетают, воронка блога, кодовое слово, контент-пакет для контент-фабрики. SKIP: paid ads (mkt-yandex-direct-epk, mkt-telegram-ads-method); SEO pages and cocoons (seo-programmatic-bofu, gist-content-logic); landing page CRO (mkt-landing-cro); publishing in the cabinets or social accounts (owner act)."
---

# Organic content: Dzen, Pinterest, Reels, blog funnel

Used by `mkt-experiment-cycle` (pack build and lint), `mkt-pulse-monitor` (CTR, read-through, watch-ratio and pin
anomalies), `mkt-project-intake` (channel passport) and `seo-brief` when an article brief targets Dzen.
This skill plans, writes briefs and checks. It never publishes: publishing is an owner act or a separate gated step.

## When / do / when not

| When | Do | When not |
|---|---|---|
| New Dzen channel | Niche gate → fan avatar (ACS ≥ 8) → Channel Bible (`bible.yaml`, frozen 3 months) → first 10 topics | Niche has < 10 live channels → take the backup niche |
| Article, pin, reel or post batch | Draft from `bible.yaml` → fact list → lint → hand-off | Draft written for an older `bible_rev` → regenerate |
| Views or reach stall | Read the anomaly table in the references, change one variable per unit | < 1000 impressions or < 3 reels → not enough data |
| Pinterest start | Setup sprint (profile → boards → pins → analysis), then daily cadence ramp | Site not claimed → claim it first |

## Procedure

1. **Passport.** Main organic channel, conversion metric, attribution (`start=` per unit or a unique codeword).
2. **Channel Bible.** Avatar, 3–5 subniches with ≥ 10 topics, 2–3 formats with monthly shares = 100, four style
   axes, recurring cover element, cadence, reader promise, USP ≤ 2 sentences. See `references/dzen-2026-algorithm-and-channel-bible.md`.
3. **Keyword map (Pinterest).** Query → cluster → board → pin title, description, overlay, landing with UTM.
   See `references/pinterest-2026-visual-seo-playbook.md`.
4. **Scripts and posts.** Hook ≤ 8 words, one idea, open loop closed at the end, one CTA; blog posts sell ≤ 1/3,
   sell through a case. See `references/reels-retention-hooks-and-blog-funnel.md`.
5. **Lint.** `python3 scripts/audit_organic_pack.py --input pack.json --strict` → `channel`, `checks[]`, `score`,
   `issues[]`, `verdict`. Exit 3 on `block`.
6. **Hand-off.** Only a pack without `block` goes to the content factory (`lp.cf-batch/1`, `organic` extension);
   every blocked unit returns to the author with its `issues[]`.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| NICHE | ≥ 10 live channels, ≥ 3 doable benchmarks, runway = topics / posts per week ≥ 12 weeks | backup niche |
| AVATAR | concreteness index ≥ 8 of 10 | finish the avatar |
| DZ-TITLE | 30–85 chars, no clickbait marker, a title keyword stem appears in the lead | rewrite |
| DZ-BODY | lead 150–600 chars with a hook; H2 every ≤ 350 words; paragraph ≤ 90 words; links ≤ 2, after 70 % of text | rework |
| PIN | keyword in first 40 chars; board shares a keyword; ratio 1.45–1.55, width ≥ 1000; overlay ≤ 8 words | rework |
| PIN-LINK | https, no shortener, `utm_source=pinterest` + medium + campaign; one URL ≤ N pins a day | block |
| REEL | hook ≤ 3 s at 2.8 words/s, no greeting; 2.0–3.5 words/s; one idea; exactly one CTA | rework |
| POST | 1–3 trigger families; one explicit bridge (codeword or `start=` bot link); selling posts ≤ 34 % | rework |
| PACK | `audit_organic_pack.py` verdict ≠ `block` | no hand-off |

## Output contract

`pack_path`, `bible_rev`, `lint_report` (the script JSON), `handoff_batch_id` or `blocked_units[]`, `metrics_plan`
(CTR, read-through, save rate, outbound CTR, watch ratio, starts by `start=`), `orders[]` (rewrites, new boards,
avatar refresh).

## Scripts

| Script | Job |
|---|---|
| `scripts/audit_organic_pack.py` | 27 item checks over four channels plus 3 pack checks (link throttle, sell ratio, one utm_campaign) |

One JSON object per run, non-zero exit with a JSON error. `--help` first, `--fixture` to dry-run.

## References

- `references/dzen-2026-algorithm-and-channel-bible.md` — feed signals, niche gate, Channel Bible schema, avatar, headline, AI pipeline, bridges.
- `references/pinterest-2026-visual-seo-playbook.md` — profile and board SEO, keyword map, pin hierarchy, cadence, outbound routing, diagnostics.
- `references/reels-retention-hooks-and-blog-funnel.md` — hook, open loop, one idea, pace, views diagnostics, account matrix, case reel to bot, blog funnel and triggers.

## Never

- Never publish or schedule in a cabinet from this skill.
- Never let clickbait pass because CTR went up: read-through decides.
- Never reuse one codeword or one `start=` value for two units.
- Never hand a pack with `verdict = block` to the content factory.
