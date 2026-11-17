# Project status, hub memory, decisions, history, artifacts

| File | Max size | Update when |
|------|----------|-------------|
| `.agents/PROGRESS.md` | ~40 lines | End of meaningful work / session; status, not durable project memory |
| lessons → hub rules | — | After a user correction or a failed approach: in a Lane Pilot PM chat use `lane_pilot_memory` `action: "lesson"` (runId, rule, audience); at a terminal, `bb lane-pilot memory write "<fact>" [--project P]` records a factual note (this skill defines no terminal lesson command) |
| `.agents/decisions/<date>-<slug>.md` | rare | Expensive irreversible choice — a draft; the docs pass publishes it to `docs/decisions.md` |
| `.agents/agent-notes/OPEN.md` | grow | Debt / simplify later |
| `.agents/session-log/*` | auto | Hooks own it — never hand-author |
| `.agents/tasks/<task-id>/` and `.agents/runs/<run-id>/manifest.json` | per task/run | Lane Pilot records; open files through the owning manifest |

## PROGRESS.md (rewrite, don't append)

```markdown
## Now
- <one sentence current reality>

## Blocked
- <or "none">

## Next
- [ ] <next concrete step>

## Last verify
- command: <what you ran>
- result: green|red
- when: YYYY-MM-DD
```

Leave `<!-- auto:session-ledger -->` … `<!-- /auto:session-ledger -->` blocks
alone — hooks own them.

After a wave of tasks, refresh PROGRESS **once**, not per micro-edit.

Standalone terminal harnesses may declare exact progress fields in their own
run contract. This skill does not prescribe replacement commands. In Lane
Pilot, the project-life helper's automatic path appends only the
`.agents/CHANGELOG.md` line; the PM/standalone planning flow owns PROGRESS and
plan updates. Task and workflow files are listed by `.agents/tasks/<task-id>/manifest.json` or
`.agents/runs/<run-id>/manifest.json`.

## Lane Pilot task and workflow records

- A task's home is `.agents/tasks/<task-id>/`; its `manifest.json` identifies
  the contract, plan, attempts, checks, reports, receipts and outcome. Ask the
  manifest; do not list folders or pick the newest file.
- A workflow graph's run is `.agents/runs/<run-id>/manifest.json`; it lists
  the files written by that run. Do not search shared artifact folders.
- Task order is only explicit `depends_on`. Lane Pilot computes dependency
  waves and refuses cycles; the planning draft does not write wave numbers.
- A writer's `ASK_PM:` is answered through `lane_pilot_answer_writer`: Lane
  Pilot rules, then the second pilot, then the PM. Escalate to the owner only
  for a secret, money, irreversible act or product decision.

## Lessons → rules on the hub

A lesson is one imperative rule, sent to the project's memory on the BB hub (Lane Pilot), from whatever machine
the session runs on. Inside a Lane Pilot PM chat call the tool `lane_pilot_memory` with `action: "lesson"` (runId, rule, audience `pm`, `writer` or `both` — required, `always` only for a rule true of every writer task). At a terminal, the documented CLI writes a factual note (`kind: note`, not a lesson — the CLI has no
`audience` or `always` options):

```bash
bb lane-pilot memory write "Run npm ci in writer worktrees, never npm install" --project <project-id>
```

The hub keeps lessons bounded: a lesson close to a live rule counts as its repeat, a new one goes on trial
(at most 12 rules in force, unused ones retire), at most 30 wait. Its `audience` field (`pm`, `writer` or
`both`) says who follows it — a `pm` rule never reaches a writer; `always` marks a rule for every writer task. Writers get only the rules their
task needs.
Do not append to `.agents/LESSONS.md`: it grew without bound (≈150 entries in one project) and every writer
read all of it. Only after a real correction or landmine — not per session. If the hub is unavailable, do not create a
local memory corpus or fallback file; retry the documented hub door when it is available.

## Decision drafts (`.agents/decisions/<date>-<slug>.md`, ADR-light)

Write one file per decision. Do not edit `docs/decisions.md`: the nightly docs pass (Lane Pilot or docs-maintain) turns each draft into an ADR there, with citations to the code, and names the draft.

```markdown
## ADR-NNN: Title
- **Date:** YYYY-MM-DD
- **Status:** accepted
- **Context:** …
- **Decision:** …
- **Consequences:** …
- **Alternatives considered:** …
```

Only durable irreversible forks. No ADRs for typo fixes.

## agent-notes/OPEN.md

Promote durable OPEN notes or close checkboxes after a green run. Night
audit (`~/.agents/bin/night-audit .`) closes OPEN items or spawns
todos/runs.

## Facts that cannot be derived

Durable non-code facts live in hub memory, not in files: use `bb lane-pilot memory search "<question>" [--project P]` or
`bb lane-pilot memory write "<fact>" [--project P]` at a terminal; in a Lane Pilot PM chat use
`lane_pilot_memory` `action: "context"` / `"lesson"`. Not a second PROGRESS.

## History & artifacts (read-only layers)

- `.agents/session-log/` — auto handoff evidence (files/shell/git), written by
  hooks. To answer "what did we do": open its INDEX, not the bulk.
- `.agents/tasks/<task-id>/` and `.agents/runs/<run-id>/manifest.json` — reports,
  receipts and screenshots produced by Lane Pilot. Immutable; link from
  PLAN.md/PROGRESS, never copy out or discover by folder listing.
- `.agents/findings/` — typed review findings (night-review). Read for prior
  evidence before re-diagnosing.

## Session-end checklist

1. PROGRESS rewritten (Now/Blocked/Next/Last verify).
2. New ideas from chat → todo items, not lost.
3. Plan task rows / ROADMAP reflect finished runs.
4. A lesson (`lane_pilot_memory` `action: "lesson"` in a Lane Pilot PM chat) or ADR only if genuinely earned.
5. OPEN checkboxes updated if debt changed.
6. Nothing important exists only in chat.
