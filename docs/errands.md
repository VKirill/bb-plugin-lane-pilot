---
title: "Errands: the page and the read model"
type: component
status: active
updated: 2026-11-01
---

# Errands: the page and the read model

**What it is.** An errand is a one-off job a helper does outside the code: the screen of a machine, a server, a site in the owner's browser, a report,
a message. A PM gives it from its chat (`lane_pilot_errand`), a schedule of kind `errand` by its clock, the lead from its tick. Every errand is a run
of the graph `errand` (`src/rooms/qa/server/errand-graph.ts`); since 0.1.465 it has a **kind**, and the kind names the row of the role table it runs
on (`docs/schedule-board.md`, «Errand kinds»). The owner asked (2026-11-01) for one place that shows which errands the system has, so the kinds can
grow over time: the «Errands» page of the scope rail (`src/rooms/errands`).

**The page** (`src/rooms/errands/ui/errands-screen.tsx`, rail item `navErrands`, test id `errands-screen`):

1. *Kinds and their models*: one line per kind (`computer`, `devops`, `browser`, `research`, `message`, no kind), what it is, BB's own model
   window (`NativeModelPicker`) seeded with the row of the role table at the global level (`get_role_models` for `GLOBAL_SETTINGS_PROJECT_ID`),
   «your choice» or «built-in default» under it and «Back to default» when the owner set the row, and the period's runs, done, stopped, failed,
   cost, and how often Jev in shadow would have named the kind. A choice is saved as `role_model.<role>` at the global level with the row's
   version and its pool kept, exactly as the role table of General settings → Team saves it (0.1.469, the owner: «the native BB picker here»).
   Two kinds on one row (`message` and no kind, both `errand`) get one window; the second line says whose model it shares. A kind with no runs
   in the period shows dashes instead of a row of zeros.
2. *Errands of the last N days* (7, 30, 90; a kind filter): when, project, the errand's title (the title it was given, else the first line of its
   brief), its kind and who named it (PM, the brief, Jev, the schedule), the model by its display name, the outcome with the helper's reason
   in plain words (`plainReason`: «you stopped the helper», «the helper did not finish the job», «the system failed at the step …», «no
   connected machine»; anything else as written), who asked (the PM chat; the schedule by name, or just «schedule» when it is named after
   the errand; «deleted» when the schedule is gone), the cost, and «Open the chat» for the helper's thread (the same side panel every helper opens in).

**Where it sits.** The rail groups the system pages for a person reading top-down (0.1.469, the owner: «systematise the pages so I am not
lost»): «Today» holds what the machines are doing and what waits for the owner's word (Waiting for you, Tasks, Errands, Schedule); then the
projects; then «Setup» (General settings, Agent profiles, Workflows, Tokens, Self-improvement). The phone select has the same three groups
(`src/rooms/ui-shell/ui/project-nav.tsx:15-30`). The work area is the full width of the plugin's pane since 0.1.469 (`src/rooms/ui-shell/ui/page.tsx:53`).
The rule since 0.1.470: a rail page shows a thing across all projects, a project's tab shows the same thing for that project under the same
name. So the project's «Tasks» tab is the rail's board locked to the project (`TaskBoard lockedProjectId`, `src/rooms/ui-shell/ui/tab-runs.tsx`),
the rail's «Schedule» and «Workflows» are what the project's «Automation» tab shows for one project, and «Agent profiles» (who the agents are)
is kept apart from a project's «Team» (who works there).

**The read model** (`src/rooms/errands/logic.ts`; RPC `errands_overview` in `src/rooms/errands/server/rpc.ts`, contract `rpc-ops.ts`) reads the
workflow journal only, no table of its own: the kind, model and source from `inputs_json` (`kind`, `kindBy`, `providerId`, `model`, `scheduleId`),
the verdict from `output_json`, the helper thread from the `errand.spawn` effect, the PM chat from the linked run's `pm_thread_id`, the schedule's
name from `lane_pilot_schedule`, the cost from the run's `cost_micro_usd`. The outcome is one of five words: *in progress*, *done* (`state: done`),
*stopped* (`state: blocked` with the helper's reason), *failed* (the run failed), *cancelled* (a canceled run, or a helper the owner stopped: its
reason says `cancel`, the same rule `schedule-service.ts` uses to post no owner row). A new kind is a row in `src/rooms/schedule/errand-kinds.ts`
and appears on the page by itself.

**Tests.** `tests/errands/errands-logic.test.ts` (outcomes, titles, the list with sources and filter, the kinds summary), `tests/errands/errands-ui.test.tsx`
(the screen, the filter and period, Russian), `tests/ui-project-nav.test.tsx` (the rail item).
