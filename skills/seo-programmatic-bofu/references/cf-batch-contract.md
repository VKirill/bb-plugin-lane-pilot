---
title: "Spec: Content Factory bridge — lp.cf-batch/1 handoff, Information Gain Gate, canary waves, feedback"
date: 2026-11-11
owner: architect-skills-and-reconcile
status: draft
sources:
  - integration-pack/07-council-roast-and-upgrades.md (E-04, E-05, E-13, S-06, M-05)
  - integration-pack/07a-council-gemini-argon-skeptic.md (§1.5, Идея 7)
  - integration-pack/07b-council-codex-pragmatist-audit.md (B03 CF adapter v1, M04, C01, C02)
  - deep-decomposition/specs/plugin-db-and-sp-executors-spec.md (§1 DDL, §3.0 ActionOrder, §3.5 drain)
  - deep-decomposition/specs/seo-5-graphs-upgrades-spec.md (§3 seo-template-scale patch)
  - bb-plugin-content-factory 0.5.190 (read-only): host/cli/usage.ts, domains/clusters/{importer,db}.ts, domains/scenarios/cli-run.ts
---

# Spec: Content Factory bridge (`lp.cf-batch/1`)

> [!IMPORTANT]
> **Reality check of the CF plugin (0.5.190, read 2026-11-11).** There is **no** `bb cf batch submit` command. The earlier specs
> (`plugin-db-and-sp-executors-spec.md` §3.5) name one; this spec replaces it with an adapter built from commands that exist today:
> `bb cf group add`, `bb cf import-clusters <group-id> --file <csv>`, `bb cf run start <scenario-id> --cluster <id>`,
> `bb cf run status <run-id> --json`, `bb cf run stop`. `import-clusters` upserts on `(group_id, cluster_key)`, so
> `cluster_key = page_id` makes the import idempotent for free. A native `bb cf batch` command is an optional v2 (§9).

## 1. Who hands off what

```text
seo-template-scale (bofu_programmatic) ─┐
seo-brief (brief per page)  ─────────────┼─► cf_handoff (sp.run_script seo-programmatic-bofu/cf_batch_handoff.py)
mkt-landing-cro-audit (variant copy) ────┘        │  writes .agents/<domain>/batches/<batch_id>.json  (lp.cf-batch/1)
                                                  ▼
                       sp.commit_memory phase=intents  → ActionOrder{kind:"content_batch"} row in lane_pilot_sp_dispatch
                                                  ▼
                       sp.dispatch_tasks (drain)  → PRE-FLIGHT (§4) → CF adapter (§5) → bb cf group/import/run
                                                  ▼
                       CF runs write tasks/<cluster>/content/* on the site folder (draft only; no publish)
                                                  ▼
                       sp.cf_feedback (§7) on the next tick → lane_pilot_sp_cf_batch + memory atoms + wave unlock
```

| Source graph | When it emits a batch | `source.kind` | Brief type | Publish |
|---|---|---|---|---|
| `seo-template-scale` | `mode=bofu_programmatic`, after `info_gain` + `similarity` + `critic=pass` | `programmatic_bofu` | comparison / alternative / migration / integration / use_case | never (draft) |
| `seo-brief` | one GIST brief accepted by its critic | `single_brief` | article / service / category | never |
| `mkt-landing-cro-audit` | `build_variant=true`, `owner_go=approve` when price/legal claims change | `landing_variant` | first-screen + offer copy for an A/B branch | never; the variant goes live only through the writer task + `sp.message_match` |

## 2. File and identity

- Path: `.agents/<domain>/batches/<batch_id>.json` in the project repo (`<domain>` = `seo` | `marketing`).
- `batch_id = idem_key = sha256(canonicalJSON({project_id, domain, "content_batch", source.graph, sorted(page_ids), brief_revision, wave}))[:32]`
  (E-04). The same plan in a replayed tick produces the same id, the outbox `PRIMARY KEY` refuses a second row.
- `page_id = <batch_id[:8]>-<slug>`; it is also the CF `cluster_key` (idempotent upsert).

## 3. JSON contract `lp.cf-batch/1`

```json
{
  "schema": "lp.cf-batch/1",
  "batch_id": "6f1c0e9a2b7d4c11a0e3f5b9c8d7e6a1",
  "project_id": "prj_x",
  "domain": "seo",
  "source": { "graph": "seo-template-scale", "run_id": "wfr_...", "node": "cf_handoff", "kind": "programmatic_bofu" },
  "brief_revision": 1,
  "wave": { "index": 1, "size": 10, "policy": "canary_10_50_full", "parent_batch_id": null },
  "cf": { "site_id": "cfs_...", "scenario_id": "cfsc_...", "group_name": "lp-6f1c0e9a-w1", "max_live_sessions": 2, "max_attempts_per_stage": 2 },
  "budget": { "estimate_id": "est_...", "reservation_id": "res_...", "cost_upper_usd": 1.84, "pages_cap_day": 20 },
  "locks": { "checked_at": "2026-11-11T08:00:00Z", "conflicts": [] },
  "items": [
    {
      "page_id": "6f1c0e9a-bitrix24-vs-amocrm",
      "slug": "bitrix24-vs-amocrm",
      "target_url": "https://example.ru/compare/bitrix24-vs-amocrm/",
      "page_type": "comparison",
      "marker_query": "битрикс24 или amocrm",
      "queries": [{ "q": "битрикс24 или amocrm", "freq": 320 }, { "q": "amocrm vs битрикс24", "freq": 90 }],
      "parent_url": "https://example.ru/compare/",
      "brief_path": ".agents/seo/briefs/6f1c0e9a-bitrix24-vs-amocrm.md",
      "information_gain_proof": {
        "serp_overlap_with_parent": 0.2,
        "serp_snapshot_id": "xs_2026-11-11_msk_desktop_ab12",
        "unique_entity_facts": ["fact:tariff.bitrix24.start=2490rub", "fact:api.amocrm.webhooks=yes", "fact:case.client42.migration_days=9"],
        "max_cosine_to_site": 0.61,
        "max_cosine_in_batch": 0.58,
        "link_donors": ["https://example.ru/crm/", "https://example.ru/blog/crm-choice/"]
      },
      "constraints": { "must_include": ["таблица тарифов", "блок «когда не подходит»"], "forbidden_claims": ["лучший на рынке"], "brandcore_rev": 7 }
    }
  ]
}
```

**Validation (zod `.strict()` in `src/rooms/specialist/cf-batch.ts`, refused rows never reach the outbox):** `items` 1..50 (E-13);
`wave.size == items.length`; every `information_gain_proof` field present; `link_donors.length >= 2`; `unique_entity_facts` ids resolve in the
fact registry (`.agents/seo/fact_registry.json` or brandcore claims) and are not shared with another item of the batch; `target_url` is not
under an active lock (§4 G-L); `brief_path` exists and its sha is recorded in the outbox payload.

## 4. Pre-flight in `sp.dispatch_tasks` (code, not a model)

The drain runs these gates **in order** for a `content_batch` row; the first failure ends with the given reason and the row stays
`pending` (or `blocked`) — nothing is sent to CF.

| # | Gate | Rule (deterministic) | Fail → |
|---|---|---|---|
| G-1 | **SERP overlap** (S-06 stage 1) | `serp_overlap_with_parent < 0.40` from a cached `mcp-xmlstock` snapshot ≤ 24 h old (≥ 4 shared URLs in top-10 = same intent) | item absorbed into the parent as an H2 (`absorbed[]` in the report), not a page |
| G-2 | **Unique facts** (S-06 stage 2) | `≥ 3` verified facts per item, none reused inside the batch | item `blocked_thin` |
| G-3 | **Anti-cannibalization cosine** | `max_cosine_to_site < 0.72` **and** `max_cosine_in_batch < 0.72` (embeddings of title+H1+first 300 words of the brief; `offerist_similarity.py`). 0.72 is a floor, not the only gate: G-1/G-2 catch paraphrased doorways the cosine misses (07a §1.5) | item `blocked_duplicate` |
| G-4 | **Indexation breaker** (S-06 stage 3) | the previous wave of this source: `indexed_14d / published ≥ 0.65` and `impressions_21d > 0`, measured from GSC/Webmaster in the **final** window `[today−10d, today−3d]` | whole batch `frozen_low_indexation`; the drain orders `seo-structure-audit` instead |
| G-L | **URL & landing lock** (C01) | no `target_url`/`parent_url` holds an active `paid_landing`, `ab_experiment`, `release` or `seo_observation` lock in `lane_pilot_sp_lock` | item `queued_conflict` |
| G-$ | **Dry-run spend estimate** (B03) | `sp.estimate` gives `cost_upper_usd` for all items × stages × `max_attempts_per_stage`; any unknown bound → refuse; then `reserveBudget(kind='llm', amount=cost_upper)` must pass the project day cap and `pages_cap_day` (≤ 20 new drafts/project/day) | batch `over_budget` |
| G-W | **Wave size** | wave 1 ≤ 10 items, wave 2 ≤ 50, wave 3 = rest; a wave > its cap is cut, the rest becomes the next wave's row (`pending`, `not_before`) | — |

A batch passes when ≥ 1 item survives G-1…G-L; the survivors are re-hashed into the final `batch_id` (the original id is kept as `parent_batch_id`).

## 5. CF adapter v1 (existing commands only)

```bash
# 1) a group per wave (name carries the batch id; re-running finds it via `bb cf group list --json`)
bb cf group add "$SITE_ID" --name "lp-${BATCH8}-w${WAVE}" --json
# 2) clusters = items; cluster_key = page_id, marker = marker_query (idempotent upsert on (group_id, cluster_key))
bb cf import-clusters "$GROUP_ID" --file ".agents/seo/batches/${BATCH_ID}.clusters.csv" --json
# 3) one run per cluster, at most max_live_sessions alive; drafts only (the scenario has no wordpress/publish step)
bb cf run start "$SCENARIO_ID" --cluster "$CLUSTER_ID" --json
bb cf run status "$RUN_ID" --json
```

- The CSV is written by `cf_batch_handoff.py`: header `Кластер;Маркерный запрос;Запрос;Частотность` (the Key Collector format that
  `parseClusterCsv` reads), one line per query.
- The brief is copied to the site folder at `tasks/<cluster-slug>/research/lp-brief.md` before `run start`, so the scenario's first agent step
  reads it (the runner gives file-writing agents the task folder; `{id}` = cluster slug).
- The chosen scenario **must not** contain a `wordpress`, `selfystudio-publish` or `telegram` native step: the adapter reads
  `bb cf scenario steps <id> --json` and refuses (`scenario_publishes`) otherwise. Publishing stays a separate owner act.
- Idempotency: the outbox row stores `{group_id, cluster_ids[], run_ids[]}` in `downstream_ref`. A replayed drain reads `run status` for every
  stored run and starts only clusters without a run (E-04). A failed `run start` becomes `unknown`, never a blind retry (E-05): the next drain
  reads `bb cf run status`/the group first.
- Concurrency: CF keeps `maxLiveSessions = 2`; the adapter starts at most 2 runs per tick and leaves the rest `pending`.

## 6. Canary rollout 10 → 50 → full

```text
wave 1 (canary)  ≤ 10 pages  → publish by the owner/site process → lock seo_observation on each URL (anchor = first indexed)
                             → after 14–21 days: indexation ≥ 0.65 AND impressions > 0 AND no doorway/manual-action signal
wave 2           ≤ 50 pages  → same lock; unlock rule re-checked on wave 2
wave 3 (full)    the rest, still ≤ 20 new drafts/project/day and ≤ 50 items per batch row
```

- A wave row is created as `pending` with `not_before = published_at(prev wave) + 14 d`; the drain re-evaluates G-4 on that date.
- Any of: indexation < 0.65, a Webmaster «малоценная/маловостребованная» flag on ≥ 20 % of the wave, a manual action → the source is
  **frozen** (`lane_pilot_sp_cf_batch.state='frozen'`), the next wave is cancelled, `seo-structure-audit` + `seo-tech-audit` are ordered.
- SEO decisions on the wave obey the 21–45 d observation lock from first indexation (07b M04): no rewrite before `anchor + 21 d`;
  IndexNow `200` is not index evidence.

## 7. Feedback back into specialist memory

A new pure executor `sp.cf_feedback` runs inside `sp-specialist-tick` (`domain=seo`, after `collect_seo`) and inside `seo-monitor`.

| Signal | Source | Written to |
|---|---|---|
| CF run state per page (`queued/running/done/error`), attempts, cost | `bb cf run status --json` | `lane_pilot_sp_cf_batch` (`batch_id, page_id, cf_run_id, state, cost_usd, artifact_sha`) |
| Draft quality: `cf-text-audit` JSON, critic verdict | CF task folder `tasks/<slug>/reports/` | same row + `lane_pilot_sp_journal` (kind `cf_quality`) |
| Indexation, impressions, clicks D14/D21/D45 | GSC/Webmaster (final window), cursor-based | `lane_pilot_sp_cf_batch.index_state`, cohort row in `lane_pilot_sp_cohort` |
| Wave verdict | G-4 rule | `lane_pilot_sp_cf_batch.wave_state` (`unlocked/frozen`) |
| Lesson | a frozen or a fully indexed wave | `upsertLessonProposal` (rule proposal, not a KV write — E-19) e.g. «comparison pages without ≥ 3 tariff facts: 31 % indexed» |
| Question | repeated freeze on one page type | shadow native question (P2) in the bank: «Is page type X worth a next wave?» |

Feedback never edits a published page. It may only (a) unlock or freeze the next wave, (b) order `seo-page-refresh` after the observation
lock matured, (c) write lessons and shadow questions.

## 8. DDL (addition to `plugin-db-and-sp-executors-spec.md` §1)

```sql
CREATE TABLE IF NOT EXISTS lane_pilot_sp_cf_batch (
  batch_id TEXT NOT NULL, page_id TEXT NOT NULL, project_id TEXT NOT NULL, domain TEXT NOT NULL,
  source_graph TEXT NOT NULL, wave INTEGER NOT NULL, parent_batch_id TEXT,
  cf_group_id TEXT, cf_cluster_id TEXT, cf_run_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','absorbed','blocked_thin','blocked_duplicate','queued_conflict','submitted','drafted','error','published','frozen')),
  wave_state TEXT CHECK (wave_state IN ('open','unlocked','frozen')),
  index_state TEXT CHECK (index_state IN ('unknown','not_indexed','indexed')),
  cost_usd REAL, artifact_sha TEXT, first_indexed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, page_id)
);
CREATE INDEX IF NOT EXISTS ix_sp_cf_batch_wave ON lane_pilot_sp_cf_batch(project_id, source_graph, wave);
```

## 9. Tests (vitest) and v2

| Test | Expectation |
|---|---|
| `cf-batch.test.ts` schema | 51 items refused; an item with 2 facts refused; a fact id shared by 2 items refused |
| `sp-dispatch.cf.test.ts` G-1…G-W | overlap 0.4 absorbs; cosine 0.72 blocks; previous wave 0.6 indexed freezes the batch and orders `seo-structure-audit`; a paid-landing lock gives `queued_conflict`; unknown tariff refuses |
| replay | the same drain twice → one group, one import, no second `run start` |
| adapter | a scenario with a `wordpress` step → `scenario_publishes`; `run start` failure → `unknown`, next drain reads status first |
| dry run | 500 items, `--dry-run` → 0 CF calls, an estimate with `cost_upper_usd` |

**v2 (optional, CF repo):** `bb cf batch submit --file <lp.cf-batch.json> --dry-run|--json` doing §5 in one transaction and returning
`{group_id, cluster_ids, run_ids}`; until then the adapter of §5 is the contract.
