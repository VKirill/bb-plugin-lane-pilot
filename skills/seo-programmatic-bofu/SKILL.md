---
name: seo-programmatic-bofu
description: "Plan programmatic bottom-of-funnel pages (comparison, alternative, migration, integration, use-case, service × geo) that pass a 3-stage Information Gain Gate, an anti-cannibalization cosine check and morphology audit, then hand a canary batch (10 → 50 → full) to Content Factory as lp.cf-batch/1. Use when: программный SEO, BOFU-страницы, «X vs Y», «альтернатива X», страницы услуга × город, массовые посадочные, пачка в Контент завод, offerist. SKIP: one article brief (gist-content-logic); site hierarchy and hubs (topical-graph-architect); rollout of an existing template (seo-release-protocol)."
---

# Programmatic BOFU pages without doorways

Used by `seo-template-scale` (`mode=bofu_programmatic`) and by `mkt-direct-search-campaign` (morphology of query clusters).
The risk is a doorway network: many pages that differ only by a word. The gates below are code; a model never waives them.

## When / do / when not

| When | Do | When not |
|---|---|---|
| A catalog or a service list has real demand per entity pair or per city | Build the entity matrix, run the gates, hand a canary batch | No demand data per row: do not create the row |
| Paid query clusters need lemma/morphology grouping | `offerist_morphology.py` only | Choosing bids → `mkt-yandex-direct-epk` |
| A previous wave is published | Read its indexation before planning the next | Previous wave < 65 % indexed at D14 → freeze, order the structure audit |

## Procedure

1. **Matrix.** One row per page candidate: page type, target query + demand, parent URL, verified facts from brandcore or the
   fact registry, SERP top-10 (cached XMLStock). A row without demand or without facts is dropped, not padded.
2. **Morphology.** `python3 scripts/offerist_morphology.py --input matrix.json` → lemma groups; rows that collapse to one lemma
   group become one page with H2 sections.
3. **Information Gain Gate.** `python3 scripts/cannibalization_guard.py --input matrix.json` — stages 1–2 of the gate table.
4. **Similarity.** `python3 scripts/offerist_similarity.py --input passed.json` — the cosine gate against the site and inside the batch.
5. **Batch.** `python3 scripts/cf_batch_handoff.py --input passed.json` → `.agents/seo/batches/<batch_id>.json` (lp.cf-batch/1,
   wave 1 ≤ 10 items) plus the Key Collector CSV for `bb cf import-clusters`. The drain (not you) runs the CF adapter.
6. **Wave review** on the next sweeps: unlock wave 2 (≤ 50) and then the rest only by the indexation rule.

## Deterministic gates (Information Gain Gate + rollout)

| Gate | Rule | Fail → |
|---|---|---|
| IG-1 SERP overlap | `serp_overlap_with_parent < 0.40` (4+ shared URLs in top-10 = same intent) | absorb into the parent as an H2 |
| IG-2 unique facts | ≥ 3 verified facts per page, none reused by another page of the batch | `blocked_thin` |
| IG-3 indexation breaker | previous wave `indexed_14d / published ≥ 0.65` and impressions > 0 (GSC final window `[−10d, −3d]`) | freeze the source, order `seo-structure-audit` |
| COS anti-cannibalization | max cosine to any site page `< 0.72` **and** inside the batch `< 0.72` | `blocked_duplicate` |
| DON link donors | ≥ 2 already indexed pages will link to each new page | no orphan pages: fix links first |
| LOCK landing | target and parent URL hold no `paid_landing`, `ab_experiment`, `release` or `seo_observation` lock | `queued_conflict` |
| WAVE size | wave 1 ≤ 10, wave 2 ≤ 50, then the rest; ≤ 20 new drafts per project per day | cut the wave |
| COST dry run | the spend estimate has no unknown bound and fits the day cap | `over_budget` |
| OBS lock | no rewrite of a wave page before first indexation + 21 days | technical checks only |

## Output contract

`batch_path`, `pilot_size`, `wave`, `absorbed[]` (rows folded into parents), `blocked[]` with the gate code, and
`orders[]` of kind `content_batch` (`batch_id = idem_key`). Drafts only: the CF scenario must not publish.

## Scripts

| Script | Job |
|---|---|
| `scripts/offerist_morphology.py` | lemma groups of queries, collapse duplicates |
| `scripts/cannibalization_guard.py` | IG-1 overlap and IG-2 facts, absorb list |
| `scripts/offerist_similarity.py` | cosine to site and inside the batch |
| `scripts/cf_batch_handoff.py` | lp.cf-batch/1 file, canary wave cut, CF cluster CSV |

One JSON object on stdout per script, non-zero exit with a JSON error. `--help` first, `--fixture` to dry-run.

## References

- `references/bofu-architecture.md` — page types, entity tables, DB schema of a programmatic set.
- `references/anti-cannibalization-gates.md` — cannibalization signals and the QA gates.
- `references/indexing-loop.md` — GSC / IndexNow loop and how to read indexation per wave.
- `references/offerist-morphology.md` — morphology audit of BOFU query sets.
- `references/cf-batch-contract.md` — the full lp.cf-batch/1 contract, pre-flight order and CF adapter.
- `references/modular-seo-block-engine-and-60pt-audit.md` — block engine that renders the pages (page = data + blocks),
  10-item DoD, doorway shingle gate, 75-check express audit scored to 100 (Kotenkov Q1 2026).

## Never

- Never send a batch of more than 50 items, or a first wave of more than 10.
- Never lower a gate threshold inside a run; thresholds change only in the charter.
- Never treat IndexNow `200` as indexation.
- Never let a CF scenario with a publish step run a batch.
