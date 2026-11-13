---
name: lane-pilot
description: "How Lane Pilot works for a PM, a graph architect or an auditor: why a task waits or is blocked, how a task contract is written, how a workflow graph is built and run. Use when: задача стоит, заблокирована, карантин, граф упал, owner спрашивает почему ничего не движется, контракт задачи, owns_paths, verification, собрать граф, lane_pilot_workflow_draft, requires, расписание графа. SKIP: project memory and lessons (lane-memory), a writer's code style (lp-writer), project life files (project-life)."
---

# Lane Pilot

The one skill about how Lane Pilot itself works. It is a router: pick the row, open that file, do what it says. The files are in `references/` next to this one.

After a context compaction only the first part of this file comes back, and the files you read do not: open the file for your row again before you act on it.

## Routes

| You are about to… | Read | Why |
|---|---|---|
| Say that something cannot be done, that you have no command, or that you do not know when it moves; a task waits (provider, quarantine, owner word, merge, secret) | references/ops.md | Symptom, check, the exact tool or command that moves it |
| Handle a blocked or failed task: critique, `needs_human`, `verdict_block`, retries spent, a red check, a Lane Pilot fault, a folder without git | references/ops-blocked.md | The way out for each reason |
| Handle a graph that failed or stopped; undo accepted work; know what only the owner decides | references/ops-graphs.md | A failed step may already have acted: check before any rerun |
| Write or review a task contract (the `plan` of a dispatch, `owns_paths`, `acceptance`, `verification`) | references/contract.md | The strict schema and the L0/L1/L2 tiers |
| Build, test, publish or start a graph (the Workflow architect, or a PM that patches or starts one) | references/workflows.md | The procedure and the rules that decide whether a graph works |
| Look up the graph format: node types, fields, edges, expressions, `requires` | references/workflows-format.md | The closed schema |
| Look up roles, the model order, presets, per-step skills, plugins, MCP, secrets, actions | references/workflows-runtime.md | What a step can reach |
| Test, publish, schedule or route a graph; goals, audit, amend, follow-up | references/workflows-lifecycle.md | The lifecycle of a graph |
| Start from a complete, valid graph | assets/example-digest.json | A graph with four test cases to copy the shape from |

## Rules that hold for every route

1. Look at the record before you answer from memory: `lane_pilot_run_health`, `lane_pilot_facts`, `lane_pilot_workflow_status`.
2. A tool that refuses tells you why in its answer: follow it before you try another way.
3. Do not tell the owner «нельзя», «нечем» or «не знаю когда» before you went through `references/ops.md`.
4. One line per stuck thing to the owner, in plain Russian, with no ids and no English codes.
5. A step that sends, pays or publishes may already have acted when it failed: check the target before any rerun.

## Old names

`lane-pilot-ops`, `lane-contract` and `lane-pilot-workflows` are stubs that point here and go away after one release. A prompt, a graph or a stored setting that still names one of them gets the right file by the table above.
