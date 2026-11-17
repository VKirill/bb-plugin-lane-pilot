# Plans — formats and rules

A plan is a committed delivery map with milestones. It spawns runs; it never
replaces them.

Do not confuse:

| Path | Role |
|------|------|
| `.agents/plans/` | interactive initiative map, ROADMAP and long-form strategy; not a task/run home |
| `.agents/tasks/<task-id>/` | Lane Pilot task home: contract, `PLAN.md`, attempts and receipts; not an interactive planning draft |
| `.agents/runs/<run-id>/manifest.json` | workflow-graph run manifest and the files registered for that run |
| `docs/plans/` | legacy strategy location: read existing content, write new plans in `.agents/plans/` |

## Create plan

1. Slug: `YYYY-MM-DD-` + kebab 3–6 words (ASCII).
2. Files: `items/<slug>/PLAN.md` + `meta.yaml`; add row to `ROADMAP.md`.
   Optional `items/<slug>/artifacts/` for discussion notes/screenshots.
3. From a todo: copy Intent/Context from its `AGENT.md`, set `source_todos`,
   mark the todo `ready`.
4. Tell user in Russian one sentence + path.

## Planning session (draft only)

If the user is shaping work and has not said «делай»:
- Keep `meta.status: draft`. Update PLAN.md + History each turn.
- Do not start a run or write `~/.claude/plans/`.
- No task contract, `owns_paths`, or `depends_on` YAML here; those belong to
  the Lane Pilot dispatch contract and task home.
- «делай» → `status: active`, then `lane_pilot_dispatch_writer`.

## PLAN.md (sections always, in this order)

```markdown
# <Title>

## Goal
One paragraph, user-visible outcome.

## Success criteria
- observable, checkable

## Scope
**In:** …
**Out:** …

## Milestones
1. <name> — done when: …

## Tasks
| # | outcome | status | run |
|---|---------|--------|-----|
| 1 | Cart survives page reload | done | ../../tasks/<task-id> |
| 2 | One-page checkout form | todo | — |

## Risks / unknowns
- what can invalidate the plan

## Links
- todos, ADRs, docs, artifacts

## History
### YYYY-MM-DD
- replans, scope cuts, learnings
```

Task rows are **coarse product outcomes** — one row per outcome, status
todo|doing|done. No task contract / `owns_paths` / `depends_on` YAML here;
Lane Pilot decomposes the work at dispatch and computes waves from explicit
dependencies.

## meta.yaml

```yaml
id: 2026-08-26-checkout-redesign
title: "Checkout redesign"
created: 2026-08-26T12:00:00+03:00
updated: 2026-08-26T12:00:00+03:00
status: draft         # draft | active | blocked | done | parked
priority: medium      # low | medium | high
scope: project        # project | global
source_todos: []      # .agents/todos/items/<id>
runs: []              # Lane Pilot workflow run ids; manifests are under .agents/runs/<run-id>/
owner: user
```

## ROADMAP.md

```markdown
# Roadmap — <project>

| status | priority | id | title | next milestone |
|--------|----------|----|-------|----------------|
| active | high | 2026-08-26-… | … | … |

## Recently done
- …
```

## Lifecycle

draft (shaping) → active (runs being spawned) → done (criteria met, evidence
in History). `blocked` = waiting on decision/external; `parked` = explicit
later with a History note why.

## Rules

- One initiative = one folder; ROADMAP is a thin index — no rows without a
  folder, no folders without a row.
- **After every finished run:** tick the task row + set its task/run reference, bump
  `updated`, refresh ROADMAP, then rewrite `.agents/PROGRESS.md`. Plan is the
  **map**; PROGRESS is the **"you are here"** — keep both, never merge.
- Replanning is normal: dated History entries, never silent rewrites.
- All tasks done → status `done` + evidence.
