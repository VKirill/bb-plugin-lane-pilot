---
name: seo-update-forensics
description: "Forensic diagnosis of a traffic/ranking drop and of a finished core update: aligned comparison windows, update quarantine, drop mechanism classification (ranking vs SERP capture vs demand vs noise), scope triage page/template/site, bottom-up 5-stage ranking pipeline, Appendix 1 checks 1-15, trust-demotion vs technical loss. Use when: сайт упал после апдейта, core update, просадка трафика, drop diagnosis, ranking drop, упали позиции, постапдейт, forensics. SKIP: routine monitoring cadence (→seo-measurement-loop); page-level refresh workflow (→seo-page-refresh graph); link risks (→seo-linkbuilding-method)."
---

# SEO Update Forensics

Diagnose a drop before fixing anything. Output: a diagnostic log with mechanism labels, a scope label per cohort, and scored hypothesis cards feeding `seo-page-refresh`, `seo-tech-audit`, `seo-structure-audit` or `seo-trust`.

## Step 0 — is an update running? (pp. 13, 38-41)

1. Record T_start/status from the official Google Search Status Dashboard, not from media.
2. While a core update is In Progress: **freeze** all structural, template, link and text edits. Log anomalies only. Set the review due date to T_end + 7 days and exit.
3. Rollout typically takes 2-4 weeks. Editing mid-rollout resets behavioral history and contaminates data.

## Step 1 — confirm the drop is real (pp. 40-41, 725-726)

- Ignore the first 1-3 days after rollout end.
- Compare the full week after T_end vs the full week before T_start, weekday-aligned. Large non-seasonal sites also compare 28 vs 28 days one month after stabilization.
- Require ≥2 metrics to fall (impressions, clicks, position).
- Rule out holidays, news, season, sales, and your own releases before calling it a drop.
- Noise band: moves within the top 5, or mixed 5-7% sitewide swings — do not edit (p. 41). A cluster falling 3-8 → 15-30 and staying is a confirmed problem.
- Confirm a *systemic* drop only if all four hold: persists ≥1-2 weeks, cluster-wide, synchronous non-brand position+impression+click loss, not explained by Trends.

## Step 2 — classify the mechanism per cohort (pp. 20-24, 39-41)

| Signals | Mechanism | Action |
|---|---|---|
| Impressions down, position off page 1, clicks down | real ranking loss | → scope + pipeline diagnosis |
| Impressions and position stable, CTR down | SERP attention capture (AI Overview, carousel, lost rich result) | view live SERP, record the feature; add applied depth a summary cannot hold; rewrite Title/snippet to promise artifacts |
| Impressions and clicks down proportionally, position stable | demand contraction / seasonality / rephrased demand | check Trends, no page edits |
| Top-5 moves / 5-7% swings | noise | none |

- Losses confined to /blog/ «what is» pages while brand and products hold → upper-funnel capture, not a sitewide filter.
- Weekly GSC beats a daily rank tracker. Do not rewrite Titles on every CTR dip; do not buy links for a CTR problem.
- Zero clicks from an AI citation is not failure by itself — track returning brand+topic demand.

## Step 3 — scope triage (pp. 44-47, 54, 59)

1. Merge GSC before/after export by URL with crawl fields (status, meta robots, X-Robots-Tag, declared vs Google canonical, click depth, inlinks, Title, H1, text length, template ID).
2. Split into functional cohorts (/blog/, /catalog/, /product/, /services/, /geo/, locale).
3. Pages losing >30% impressions → grounded LLM chain extracts shared traits → 3-5 ranked hypotheses with exact URLs and values, bucketed: technical bug / template defect / weak intent match / E-E-A-T deficit / linking break — each with the verification data still missing.
4. Winners-vs-losers contrast: 20 pages in top 3 vs 20 same-section pages below top 20 — compare headings, Title wording/length, internal links, trust blocks, canonicals.
5. Scope labels: one URL while neighbors hold → **local**; a homogeneous group/template drops together → **template**; all key sections + index bloat + canonical failures + trust loss → **site-wide**.
6. A defect on >20-30 same-type URLs is a template defect until proven otherwise. Discard single-URL conclusions.
7. Manually inspect 3-5 best and 3-5 worst URLs in a browser + URL Inspection before writing specs.
8. Map scope to remediation — local: rework the document; template: redesign the template/logic/filters/folder linking; site: index purge, niche focus, E-E-A-T, hierarchy rebuild. Never apply single-page edits to template or domain failures.

## Step 4 — bottom-up 5-stage pipeline (pp. 23, 26-31)

For pages with a real ranking issue, locate the stalled stage by position band and fix from the lowest failing stage up:

| Band | Stage | Check |
|---|---|---|
| invisible at 50-100 | 1 lexical/vector retrieval | crawling in 30-day logs; entity in Title, H1, URL, first 100 words; descriptive anchors; indexing |
| stuck at 40-80 | 2 site quality / link graph | hub links, no orphans, 5xx/TTFB, clutter reduced |
| stuck at 15-35 | 3-4 intent vector + deep models | one dominant intent; micro-intent H2-H3 with direct answers; thesis up front; self-contained sections; negations; author credentials |
| top 10 then slides | 5 behavioral / twiddlers | CTR-tested Titles, first-screen retention, cannibalization, deep rewrite on bad click history |

Rules: no regular Googlebot hits in 30-day logs → stop and fix crawl/architecture first. Bad click history → radical structural rewrite, not a date bump. Hybrid guide+catalog+form URL → split it. Stage 3 passes ~20-30 candidates to stage 4; behavioral data aggregates ~13 months.

- Extended methodology & checklists: `references/core-playbook.md`

## Verified Scripts

- `scripts/drop_window_split.py` — deterministic CLI check (`--fixture` / `--input`).
- `scripts/channel_isolation.py` — deterministic CLI check (`--fixture` / `--input`).

## Wave-2 Distilled References

- `references/traffic-drop-detective-forensics.md` — operational playbook and thresholds.
- `references/ranking-signals-2026-white-pf-and-dynamic-serp.md` — operational playbook and thresholds.
- `references/02-gsc-cohorts-and-anomaly-forensics.md` — operational playbook and thresholds.
