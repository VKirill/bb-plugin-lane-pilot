# Procedures — planning session, decisions, linking, rituals, ambiguity, layers

## Planning session

Stay here until the user says «делай / реализуй / в работу / запускай ран».

Triggers: «планируем», «пока план», «не запускай», «обсудим», «спланируй»,
«разбей на этапы», «только карта», «пока не в ран».

1. Create or open `.agents/plans/items/<YYYY-MM-DD-slug>/` (`status: draft`).
2. Each decision → edit `PLAN.md` + dated **History**. Chat is not the store.
3. Screenshots / notes → optional `items/<slug>/artifacts/`; link from PLAN **Links**.
4. Ask the next scoped question. Do not invent a run or score a conveyor.

Forbidden until «делай»:
- starting a run, spawning writers, or writing task contracts / `owns_paths`
- Claude Code **Plan mode** and any write under `~/.claude/plans/`
- task YAML in this interactive `PLAN.md`

If the host is already in Claude Plan mode: tell the user to switch to
**default** and keep writing under `.agents/plans/`. Do not copy the
harness file as the canon (you may quote it once into `PLAN.md`).

UI / visual initiative: Links must include `docs/DESIGN.md`. If it is
missing, spawn **design-lead** (skill `project-design`) or draft DESIGN.md
here — do not start a UI run without it.

Exit: «делай» → Lane Pilot: `lane_pilot_dispatch_writer`. Set plan
`status: active`, link the Lane Pilot task/run in the task table + `meta.yaml.runs`. A standalone terminal harness is outside this
skill; consult its current local documentation rather than inferring a replacement command.


## Decision guide (where does X go?)

| X | Goes to |
|---|---------|
| "we should someday…" | **todo** |
| "we will, in this order…" | **`.agents/plans/`** (delivery map) |
| long-form strategy / COCOON | **`.agents/plans/`** (not a coding queue) |
| "change code now" | **Lane Pilot task dispatch** (never directly from todo/plan). The task home holds its `PLAN.md`; a workflow graph has its own run manifest |
| "current state of reality" | **PROGRESS** (≤40 lines, rewrite not append) |
| "we got burned by…" | **lesson** → `lane_pilot_memory` `action: "lesson"` in a Lane Pilot PM chat; terminal `bb lane-pilot memory write` is for a factual note, not a lesson command |
| "we chose A over B forever" | **draft in `.agents/decisions/`** → published to `docs/decisions.md` |
| leftover debt / simplify later | **`.agents/agent-notes/OPEN.md`** |
| planning-session notes / screenshots | **`.agents/plans/items/<slug>/artifacts/`** (until a run exists) |
| reports, screenshots, receipts after a run | the owning **task home** or **workflow run manifest** (immutable records; open via the manifest) |
| "why is this code here" | session-log / findings (read only) |


## Linking discipline (what makes it ONE system)

Every hop leaves a back-link so any file leads to the full trail:

- todo `meta.yaml.related_runs` ↔ plan `meta.yaml.source_todos`
- plan task row `task/run:` link ↔ the Lane Pilot task home or workflow run manifest
- task and workflow files stay where their manifest records them — link load-bearing
  ones from PLAN.md **Links** and PROGRESS, never copy them around
- Lessons and ADRs name their evidence (run, test, artifact)


## Rituals

**Session start:** read `.agents/PROGRESS.md` (project rules reach you through CORE and the brief) →
ROADMAP + todos INDEX **counts only**. Don't dump session-log into context.
Cold start / unknown repo: skill `project-resume` (terminal CLI: `~/.agents/bin/resume-project .`), then this skill
for writes. Lane writers under a task contract do not edit shared project-level `.agents/` planning files; they may write
their own `QUESTIONS.md` and `CHECKPOINT.md` under the task-home attempt folder. Lane Pilot owns each task home and
workflow run manifest. This skill's planning writes are for the PM / interactive agent.

**After a green run (standalone terminal; in Lane Pilot the helper appends CHANGELOG only):** tick plan task → refresh ROADMAP → rewrite PROGRESS
(Now/Blocked/Next/Last verify) → a lesson only if corrected → ADR only if a
durable fork was locked. After a **wave** of tasks, refresh PROGRESS once,
not per micro-edit. Schema-v2: declare `progress_now` / `close_next` /
`close_open` in the standalone harness's run contract; that harness applies them — never guess stale checklist lines. Lane Pilot's
script-only helper records the CHANGELOG line; it does not use these terminal planning paths.

**Session end:** PROGRESS current; new ideas from chat filed as todos;
session-log untouched (hooks own it).

**Delegate the bookkeeping (standalone Claude workflow):** when a ritual touches more than one
file (PROGRESS + plan row + ROADMAP/INDEX, or filing todos), dispatch the
`memory-scribe` subagent (Haiku) with 3–5 bullets of what happened — it
formats and files per `references/`. Write **lessons and ADRs yourself** (judgment
calls). Single quick append — just do it. Other CLIs: write directly.

**Init a repo:** `~/.agents/bin/project-memory-init <repo>`; full passport:
`/project-onboard`. If only root `PROGRESS.md` / `LESSONS.md` exist, init
and session-ledger migrate them into `.agents/`.

**Night audit:** `~/.agents/bin/night-audit .` or read `AUDIT-*.md`. Close
OPEN items or spawn todos/runs.


## Ambiguity protocol

A vague ask («сделай красиво», unclear scope, two plausible readings) is
**not** a license to guess. Order of preference:

1. Look it up yourself — code, PROGRESS, plans, todos, session-log, and the Lane Pilot task/run manifest when applicable.
2. Still ambiguous → ask the user a **structured question with 2–4 options**
   (Claude: AskUserQuestion), not an open-ended one.
3. Never silently pick an interpretation for destructive or scope-changing
   work. For trivial reversible work: pick the obvious reading, say so.


## Keeping the layers right

- Interactive todos, plans and local results never live only in chat; durable project facts and lessons live only in hub memory.
- The project plan is `.agents/plans/`, not Claude Plan mode or `~/.claude/plans/`; it is a delivery map, not a task/run queue, so it holds no task contract or `owns_paths` and no run starts during a planning session.
- One layer per file: todo, plan and PROGRESS stay separate. PROGRESS is rewritten, not appended to; plans and todos link the runs that shipped them.
- `docs/` holds only the code documentation; plans, research and reports go to `.agents/`.
- Production code changes go through a Lane Pilot task dispatch, never straight from a todo or plan; ideas are files, not an orchestrator MCP `todo_add`.
- Durable files are English and contain no secrets.
