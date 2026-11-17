---
name: project-life
description: "Единый скилл ведения задач и жизни проекта: идеи/туду → планы/roadmap → раны → артефакты → прогресс/уроки. Use when user says туду, запиши, идея, backlog, потом, план, спланируй, планируем, пока план, не запускай, обсудим, roadmap, этапы, приоритеты, прогресс, урок, итоги — or todo, plan, planning, lesson, progress. Cold-start «где мы / handoff / продолж» is project-resume, not this skill. `$ARGUMENTS` exactly info prints the card."
argument-hint: "[info]"
---

# Project life — one skill for tasks & project memory

> **Inside a Lane Pilot chat** (`LANE_PILOT_AGENT_TYPE` set / tools `lane_pilot_*` present) the project-life helper has a script-only path: it appends one `.agents/CHANGELOG.md` line and commits that change. It does not update PROGRESS, ROADMAP or plan ticks; the PM or standalone planning flow owns those updates. The PM keeps interactive `.agents/todos/`, `.agents/plans/` and decision drafts. «делай» = `lane_pilot_dispatch_writer` (the whole plan at once); task order is only explicit `depends_on`, and waves are computed by Lane Pilot. A writer's `ASK_PM:` is answered through `lane_pilot_answer_writer`: Lane Pilot rules, then the second pilot, then the PM; the owner is asked only for a secret, money, an irreversible act or a product decision. With `owner.words = sensitive`, a verified task or phase pause waits for the owner only for money, a database migration or a production deploy; every other pause is decided by Lane Pilot. A lesson = `lane_pilot_memory` `action: "lesson"` (runId, rule, audience pm, writer or both — required; `always` only for a rule true of every writer task). Project facts and lessons live only in hub memory: use `lane_pilot_memory` `action: "context"` / `"lesson"` in Lane Pilot, or the documented `bb lane-pilot memory search "<question>"` / `bb lane-pilot memory write "<fact>"` CLI at a terminal. Terminal harness commands below are standalone guidance, not Lane Pilot aliases.

## Info

If `$ARGUMENTS` is exactly `info`, print `references/info.md` verbatim (Russian), then stop. Do not create a todo or plan unless the user already asked for that in the same message.

Interactive plans, todos and local status records live under `.agents/`; Lane Pilot task and workflow records use the task/run paths below. Durable project facts and lessons are hub memory, not local memory files.
**Durable files: English only.** Chat may be Russian — answer in RU, write EN
to disk. Never put secrets in any of these files.
**No orchestrator MCP.** No `todo_add` / task CLI for ideas.

## The lifecycle (one mental model)

```text
idea ──► todo ──► plan ──► run ──► merged work
        (backlog) (map)   (execution)   │
                                        ▼
              status/trace: PROGRESS · decisions · session-log · task/run records
              memory: facts and lessons → hub
```

Skipping layers **upward** is fine (small fix: idea → run). Skipping the
memory update after work is not.

## Folder map

```text
<project>/.agents/
  todos/            # ideas backlog        → references/todos.md
    INDEX.md
    items/<YYYY-MM-DD-slug>/{README.md, AGENT.md, meta.yaml}
  plans/            # delivery map         → references/plans.md
    ROADMAP.md
    items/<YYYY-MM-DD-slug>/{PLAN.md, meta.yaml, artifacts/}
  tasks/<task-id>/  # one Lane Pilot task home; manifest.json is the index
    manifest.json, contract.v<N>.json, PLAN.md, attempts/...
  runs/<run-id>/    # one workflow-graph run; manifest.json is the index
    manifest.json and only the files it lists
  PROGRESS.md       # now / blocked / next → references/memory.md
  agent-notes/OPEN.md
  session-log/      # hooks own it — read only
  decisions/        # decision drafts; the docs pass publishes them to docs/decisions.md
<project>/docs/                # code documentation only, kept by the docs pass
```

Choose project root when cwd has `.git`/`package.json`/`CLAUDE.md`; use
`~/.agents/...` when user says «глобально» or cwd is home.

## When to apply what

| User says (≈) | Do | Reference |
|---------------|----|-----------|
| «занеси в туду / запиши / потом / не теряй» | Create/update todo item + INDEX | `references/todos.md` |
| chat about a todo, no «запиши» | Do not invent a todo; ask if they want it filed | — |
| «покажи туду / что в бэклоге» | Read INDEX + open items, answer in RU | — |
| «закрой / сделано / не надо» | status done/dropped + INDEX | `references/todos.md` |
| «планируем / пока план / не запускай / обсудим / спланируй / разбей на этапы» | **Planning session** — draft in `.agents/plans/`, no run | `references/plans.md` |
| «архитектор / новое приложение / новый сервис / спроектируем продукт» | Load **app-architect**. Same plan folder, living `artifacts/`. No run | skill `app-architect` |
| «что дальше по проекту» (already in session) | PROGRESS → ROADMAP → todos INDEX counts | — |
| «делай / реализуй / в работу / запускай ран» | Exit planning. Lane Pilot: `lane_pilot_dispatch_writer`; pass the plan text and explicit `depends_on` links. Standalone terminal run commands are outside this skill's documented scope. Link the task/run from the plan | `skills/lane-pilot/` |
| run закончился зелёным | Terminal: tick plan task → refresh ROADMAP → rewrite PROGRESS. Lane Pilot's script-only helper appends `.agents/CHANGELOG.md`; the PM/standalone flow owns plan and PROGRESS updates | `references/memory.md` |
| поправили тебя / наступил на грабли | One lesson. Lane Pilot PM: `lane_pilot_memory` `action: "lesson"` (runId, rule, audience). Terminal: use `bb lane-pilot memory write "<fact>" [--project P]` for a factual note; this skill defines no terminal lesson command | `references/memory.md` |
| зафиксировано крупное необратимое решение | draft in .agents/decisions/<date>-<slug>.md (the docs pass publishes it to docs/decisions.md) | `references/memory.md` |
| «итоги / конец сессии» | PROGRESS current, ideas filed as todos, no orphan runs | `references/memory.md` |
| «что делали / почему так / покажи отчёт» | Read session-log INDEX, run artifacts, findings — don't write them | — |
| «где мы / handoff / продолж» (cold start) | Skill `project-resume` (terminal CLI: `~/.agents/bin/resume-project .`), not this file | `skills/project-resume/` |

## Procedures — required reading

Read `references/procedures.md` **before** acting on anything it covers: the planning-session
mechanics and forbidden list, the decision guide, linking discipline, the session rituals
(start / after a green run / session end / delegation / repo init / night audit), the
ambiguity protocol and the layer rules. The table above decides **when**; the reference
decides **how** — none of it is optional and it is not repeated here.

## Writing formats

Exact file templates live in this skill's `references/` (`todos.md`,
`plans.md`, `memory.md`). Read the matching relative file **before creating or restructuring**
any of these; skip it for trivial appends you already know the shape of.
