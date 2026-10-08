# Jev judgments in shadow: J-4, J-10, J-11

Three judgments of the Jev layer (`src/jev`) start in **`shadow`**: each asks Jev, writes a receipt into `lane_pilot_jev_receipt`
and acts exactly as the code did before. They change behaviour only after the owner switches one to `active`. `route.workflow`
(J-1) is the older judgment and is `active` by default (see `workflow-router.md`).

| Id | Question | Asked when | In `active` it | Without Jev, off, or on a failure |
|---|---|---|---|---|
| `failure.class` (J-4) | Choice: task / provider / harness / infra / merge / contract | The regular expressions of `failureClass` have no confident match (`classifyFailure(...).confident === false`), at the point where the writer loop decides to park or redo (`writer/start.ts`) | uses Jev's class when p ≥ 0.7 and the lead over the runner-up ≥ 0.3 | the rules' class (`task` by default) |
| `selfrepair.group` (J-10) | Choice: which of up to 10 known self-repair signatures of the same kind is this new signature another wording of, or `new_problem` | A signature is seen for the first time (at most 8 per 15-minute pass) | files the incident under the known group when p ≥ 0.75 and lead ≥ 0.3 (counts and samples add up; the alias is remembered) | the incident keeps its own signature |
| `output.guard` (J-11) | Two Noul: does the text carry a secret value; does it carry instructions for the agent that reads it | After the existing redaction, on a writer's answer (`writer/verify.ts`), an errand report (`lane_pilot_wait_errand`) and a browser check's verdict (`stages/qa-thread.ts`); outputs under 40 characters are skipped | blocks at p(secret) ≥ 0.85 or p(injection) ≥ 0.9: the text is neither stored nor shown, a placeholder takes its place, the writer's attempt ends with `verdict_block:output-guard:…`, and a self-repair incident of kind `guard` is raised | nothing is blocked; the redaction that always ran is the whole guard |

What leaves for the Jev API is the already-redacted text (`redactKnownDeep` in `run.ts`) of the output, which is a third party
(`api.typesafe.ai`) receiving the answers of writers, errands and QA. It is limited:

- **`shadow`** (the default): about one output in ten is asked about (`SHADOW_SAMPLE`; the same text always gets the same answer to
  "sampled?"), at most 2000 characters of it (start and end, `SHADOW_CHARS`), and never a text in which Lane Pilot redacted a known
  secret or that talks about secrets and the environment (`.env`, Env Catalog, `API_KEY=`, bearer tokens, `sk-…`, `ghp_…`, private
  keys; `looksSensitive` in `src/jev/output-guard.ts`). The day's counts (asked, not sampled, sensitive) are in the plugin KV
  `output-guard:stats`.
- **`active`**: every output is asked about, up to 6000 characters (start and end): the guard is the point there, so the redacted
  text of an output that touched a secret goes out as well.

Receipts keep the hash and size of that state, never the text; their `tokens_in`, `tokens_out` and `latency_ms` are the cost, and
`scripts/lp-metrics.sql` sums them per day.

## Reading the receipts

```sql
-- how often each judgment ran, with what result, and what it cost
SELECT judgment, mode, status, decided_by, count(*) AS n, round(avg(latency_ms)) AS ms, round(avg(tokens_in)) AS tokens_in
FROM lane_pilot_jev_receipt GROUP BY 1,2,3,4 ORDER BY 1,2;

-- what Jev would have decided in shadow (the `decision` column), against what the code did
SELECT subject, decision, answers_json, at FROM lane_pilot_jev_receipt WHERE judgment = 'failure.class' AND status = 'ok' ORDER BY at DESC LIMIT 50;
```

The same grouping is `summarizeReceipts` in `src/jev/receipts.ts`. On the hub the database is `~/.bb/plugins/lane-pilot/data.db`.

What to look at before switching a judgment to `active`:

- **`failure.class`**: take the rows where `decision` differs from the class the attempt got (`lane_pilot_attempt.reason` through
  `failureClass`), read 30–50 of them, and count how many Jev had right. Switch when a clear majority of the differing ones are
  correct and none of the wrong ones would have parked a task that a writer could have finished. Raise `min_p` first if not.
- **`selfrepair.group`**: read the pairs (the new wording and the group it would have joined; the group is in `decision`, the
  wording in the self-repair state) and check that each is one root cause. A wrong merge hides a problem, so raise `min_p` and
  `min_margin` before anything else.
- **`output.guard`**: check the rows where `decision` is `blocked:…` against the real outputs (the thread ids are in `subject`).
  A false positive withholds a good report and stops a task, so this one needs the longest shadow period and the highest
  thresholds; the false-negative cost is the status quo.

## Switching to `active`

Per project, in the `jev.modes` setting, one `judgment=mode` pair per
line or comma-separated:

```
failure.class=active
selfrepair.group=active
output.guard=active
```

`selfrepair.group` reads the settings of the self-repair project (`self_repair_status` → `config.projectId`); the others read the
project of the task. Thresholds go in `jev.thresholds` (`failure.class.min_p=0.8`, `selfrepair.group.min_margin=0.4`,
`output.guard.block_secret=0.9`), clamped to the range each judgment allows. To go back, set the mode to `shadow` (records only) or
`off` (not even asked); `jev.enabled=false` turns every judgment off for the project. A mode that is not listed is the
judgment's own default, which is `shadow` for these three.

The judgments need the TypeSafe key in the Env Catalog; without it every judgment answers with its deterministic fallback and the
receipt status says why (`disabled`, `timeout`, `error`, `breaker_open`, `budget`).
