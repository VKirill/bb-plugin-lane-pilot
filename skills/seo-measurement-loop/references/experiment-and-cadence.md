# Experiments, Change Log and cadence — reference

Source: «SEO Монстр 2027» ch5 pp. 458–470, ch1 pp. 47–51.

## Test-vs-control experiment (pp. 458–459)

- Pilot: 30–50 homogeneous URLs on large catalogs; ~20–25 elsewhere.
- Control: same template, same depth, same baseline, untouched.
- Windows: 14 or 28 days, aligned by weekday.
- Validation horizon: two weeks or one month of positive delta vs control before scaling.
- Clock starts only after recrawl and reindex are confirmed.

## SEO Change Log schema

Record before release:

| Field | Note |
|---|---|
| release_date | day the change shipped |
| index_date | recrawl/reindex confirmed — clock starts here |
| template | affected template |
| test_count / control_count | URLs in each cohort |
| elements_added | what exactly changed |
| hypothesis | with target % deltas |
| pre_window / post_window | 14 or 28 days, weekday-aligned |
| control_check_date | due date of the evaluation |
| cancel_criteria | what falsifies the hypothesis |

No stacked changes: one isolated change per cohort per day; <10 unrelated changes per day per cohort (p. 464).

## Impact cascade — read in order

1. Impressions and query breadth
2. Cluster position
3. Snippet CTR
4. On-page micro-conversions
5. CRM leads and orders

Interpretation: impressions/clicks +30% with zero form submissions → relevance improved, look for on-page commercial or UX barriers. Doctor profiles growing on "specialty + district" with bookings → local entry confirmed; surname-only growth only strengthens the profile.

## Weekly loop (pp. 464–468)

- **Monday — signals**: export directory slices; index & first impressions of URLs published 7–14 days ago; positions 8–20 with low CTR; impressions-up/clicks-flat flags; query-page pairs in margin clusters; next-step conversions; geo routing lands on branch pages; 5–10 anomalous pages inspected in a browser; pick 3–5 tasks scoring 10–12.
- **Tuesday — quick wins**: snippets, commercial transitions, contextual links from dormant donors.
- **Wednesday — template work**: one template, one cohort, one hypothesis.
- **Thursday — content/E-E-A-T enrichment**: grounded extraction, SME approvals.
- **Friday — QA**: line-by-line pre-publish check, recrawl requests, Change Log entries, TTL review.

Keep analytics, editing and coding on separate days — no context switching within a day.

## Monthly loop (pp. 465–466)

- Non-brand trends by template and cluster.
- Cohorts losing CTR while still top-5.
- Support articles eating commercial demand.
- Link throughput from guides to commercial pages.
- 30–60-day survival of new clusters.
- Queue cleanup; audit 10–15 aging flagships (dates, snippet vs first screen, cluster lead, commercial widgets).

## Quarterly loop (p. 466, 469–470)

- Target→Mixed→Support pyramid: orphans, dead ends, blurred jobs; topic drift.
- Sitemap ↔ server-log reconciliation; remove crawl traps; clear crawled-not-indexed.
- Trust pages, sameAs links, YMYL review dates, NAP vs GBP.
- Vertical checklist below.

## Vertical checklists

- **E-commerce**: dl specs on top-200 SKUs (quarterly), size/compatibility tables, facet stock thresholds, colour/size duplicates, URLs with impressions but no cart adds.
- **Medical**: service–doctor–branch bindings; freshness of prices, prep rules, contraindications; query→service→doctor→branch chain; reviewer signatures.
- **Local**: mystery-shop every card; zones and rates; review distribution across branches.
- **SaaS**: help center synced with changelog; demos and calculators tested; article→signup transitions tracked.

## Three-queue backlog rules (pp. 49–51)

Six required fields per task: problem level, problem type, scale, expected effect, verification method, re-review date — plus owner, confirmed dependencies, explained pattern. Missing field or dependency → not ready.

- Queue A: blockers (index, canonical, robots, 5xx, duplicates, junk index, template errors, critical mobile UX).
- Queue B: multipliers (templates, sections, links, trust, structure, content systems).
- Queue C: local tweaks (title, FAQ, snippets, microcopy). Never preempts open A/B.
- Idea Archive for unverified ideas; WIP 1–2 major hypotheses per section.
- Group defects by template; revenue tasks by money cluster.
- Weekly cleanup, monthly stop-list of low-impact actions, quarterly scaling-blocker audit.

## Anti-patterns

- Non-homogeneous control; rolling out to 10k URLs at once.
- One mixed backlog; "check SEO" tasks; repeated cosmetic Title edits; no calendar time for evaluation.
- SEO run as one-off campaigns.
