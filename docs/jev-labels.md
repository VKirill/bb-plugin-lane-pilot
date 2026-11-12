# Jev judge labels (H1)

Every `lane_pilot_jev_receipt.outcome` is a label the calibration reads (`bb lane-pilot jev calibrate`, `--by-source` splits them).
Three sources:

- **escalated** — bare `agree` / `disagree`, written by the stronger judge the case was handed to (the old path, rare).
- **outcome** — `agree:outcome[:detail]` / `disagree:outcome[:detail]`, written by the nightly graph `lp.jev-labels`
  from the pipeline's own later truth. No model, no cost.
- **model** — `agree:model` / `disagree:model`, the same night: the project's rules-analyzer (a stronger model of another
  family) re-answers the judgment's questions over the sampled input **without seeing Jev's answer**, and its re-decision
  is compared with the receipt. At most 20 relabels per judgment per night, 120 in all.

## Outcome rules (packages/jev/src/labels-outcome.ts)

| Judgment | Truth | agree when |
|---|---|---|
| `critique.screen` | the task's fate | `pass` and accepted without regression/`<id>-mainfix`; `fail` and the attempt failed/blocked |
| `critique.worth` | the task's fate + the plan critique's verdict | skip of `plan_critique` and accepted; run and the critic found something |
| `lead.predict` | `lane_pilot_decision` verdict (owner label or judge) | `exact`/`partial` → agree, `miss` → disagree, `deferred` unlabeled |
| `guard.host_command` | the permit decision (journal `class='permit'` once that surface lands) | `allow` confirms a safe read, `deny` a stop |
| `failure.class` | run terminal state (existing sweep, runs/failure-class-model.ts) | accepted, or a `task` reading on a dead run |
| `route.workflow` | the routed `lane_pilot_wf_run` (existing sweep) | succeeded and the same graph went |
| `plan.fact` | accepted attempt + the stage's code verdict (existing sweep) | Jev's per-item read matches the code's |
| `invoice.check` | run terminal state (existing sweep) | accepted ⇔ `match` |

Age bound before a receipt is labeled: 24 h for task-bound judgments (the truth needs time to land).
Labeled rows are never relabeled — every query carries `outcome IS NULL`.

## Judgments with no later truth → source B (model labels)

`errand.kind`, `intake.weight`, `learning.*`, `graph.step_trivial`, `lead.judge`, the package judgments that only rank
(`memory-rerank`, `log-trim`, `test-hint`, `ui-shots`, `render-match`,
`employee-remark`, `repair-group`, `anamnesis.*`, `wall.filter`, …): nothing downstream records
whether the pick was right, so the model relabeler is their only label source until a real outcome rule is written.
`guard.host_command`'s outcome rule returns rows only once permit answers reach `lane_pilot_decision` — today permit
answers live as files on the host (`~/.agents/permits`), so it is effectively source-B too.

## Sampling (`input_json`)

`insertReceipt` keeps the judgment's input (redacted like the state, `redactKnownDeep`) in the new nullable column
`input_json` for one receipt in five — deterministic on `input_sha256` (first 8 hex digits mod 5), capped at 8 KB with a
`…[truncated]` marker. A truncated row may not parse; the labeler skips what it cannot parse. Inputs may contain project
text; the same secret redaction as the state applies. `decide()`-time input is what is stored, so the relabeler
re-renders `stateBuilder` + `questions` and the prompt matches what Jev saw exactly.

## Surface

- `bb lane-pilot jev calibrate --by-source`: per judgment, agree+disagree counts by source.
- Self-improvement page → «Судьи»: name in Russian, labeled count, accuracy, fit (gate / sort-only / dead).
- `judgeAccuracy(db, judgmentId)` (`src/rooms/jev`): `{labeled, accuracy} | null` for the autonomy tiers.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Roles, agents and models](guide/roles.md)
