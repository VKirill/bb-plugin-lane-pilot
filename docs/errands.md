---
title: "Errands: the page and the read model"
type: component
status: active
updated: 2026-11-01
---

# Errands: the page and the read model

**What it is.** An errand is a one-off job a helper does outside the code: the screen of a machine, a server, a site in the owner's browser, a report,
a message. A PM gives it from its chat (`lane_pilot_errand`), or a schedule of kind `errand` runs it. Every errand runs
the graph `errand` (`src/rooms/errands/server/handlers/errands-graph.ts`, `src/rooms/errands/server/services/errand-graph.ts`); it has a **kind**, and the kind names the row of the role table it runs
on (`docs/schedule-board.md`, «Errand kinds»). The «Errands» page of the scope rail lives in `src/rooms/errands` (`errands-screen.tsx`, rail item `navErrands`).

**The page** (`src/rooms/errands/ui/errands-screen.tsx`, rail item `navErrands`, test id `errands-screen`):

1. *Kinds and their models*: one line per kind (`computer`, `devops`, `browser`, `research`, `message`, no kind), what it is, BB's own model
   window (`NativeModelPicker`) seeded with the row of the role table at the global level (`get_role_models` for `GLOBAL_SETTINGS_PROJECT_ID`),
   «your choice» or «built-in default» under it and «Back to default» when the owner set the row, and the period's runs, done, stopped, failed,
   cost. A choice is saved as `role_model.<role>` at the global level with the row's
   version and its pool kept, exactly as the role table of General settings → Team saves it (0.1.469, the owner: «the native BB picker here»).
   Two kinds on one row (`message` and no kind, both `errand`) get one window; the second line says whose model it shares. A kind with no runs
   in the period shows dashes instead of a row of zeros.
2. *Errands of the last N days* (7, 30, 90; a kind filter): when, project, the errand's title (the title it was given, else the first line of its
   brief), its kind and who named it (PM, the brief, the schedule), the model by its display name, the outcome with the helper's reason
   in plain words (`plainReason`: «you stopped the helper», «the helper did not finish the job», «the system failed at the step …», «no
   connected machine»; anything else as written), who asked (the PM chat; the schedule by name, or just «schedule» when it is named after
   the errand; «deleted» when the schedule is gone), the cost, and «Open the chat» for the helper's thread (the same side panel every helper opens in).

**Where it sits.** The rail groups the system pages for a person reading top-down (0.1.469, the owner: «systematise the pages so I am not
lost»): «Today» holds what the machines are doing and what waits for the owner's word (Waiting for you, Tasks, Errands, Schedule); then the
projects; then «Setup» (General settings, Agent profiles, Workflows, Tokens, Self-improvement). The phone select has the same three groups
(`src/rooms/pages/ui/project-nav.tsx`). The work area is the full width of the plugin's pane (`src/rooms/pages/ui/page.tsx`).
The rule: a rail page shows a thing across all projects, a project's tab shows the same thing for that project under the same
name. So the project's «Tasks» tab is the rail's board locked to the project (`TaskBoard lockedProjectId`, `src/rooms/pages/ui/tab-runs.tsx`),
the rail's «Schedule» and «Workflows» are what the project's «Automation» tab shows for one project, and «Agent profiles» (who the agents are)
is kept apart from a project's «Team» (who works there).

**The errand routes its brief.** Before `lane_pilot_errand` starts a plain errand it routes the brief with the same router the PM's
`lane_pilot_route` uses, over the project's offered catalog (`routedGraph` in `src/rooms/errands/server/services/errand-graph.ts`). A match with `decision: "route"` and
confidence ≥ 90 (`ERRAND_ROUTE_CONFIDENCE`) starts that graph's run when offered (`published` or `tested`, except `authorized: true` routes only to `published`).

Every plain errand run records what the router said in its `inputs_json` (the errands page and `lead` `nearest` read it): `routeTop` is
`<workflowId>:<confidence>` of the top match or empty, and `routeWhy` is `below_confidence`, `missing_inputs:<names>`, `not_offered`, `tested_needs_unauthorized`, or `none`.

**The read model** (`src/rooms/errands/models/errands.ts`; RPC `errands_overview` in `src/rooms/errands/server/handlers/errands-rpc.ts`, contract `rpc-ops.ts`) reads the
workflow journal only, no table of its own: kind, model and source from `inputs_json`, verdict from `output_json`, helper thread from `errand.spawn`, PM chat from `pm_thread_id`, schedule name from `lane_pilot_schedule`, cost from `cost_micro_usd`. Outcomes: *in progress*, *done*, *stopped*, *failed*, *cancelled* (`schedule-service.ts` posts no owner item on cancel). A new kind is a row in `src/rooms/schedule/models/errand-kinds.ts`
and appears on the page automatically.

**Tests.** `tests/errands/errands-logic.test.ts` (outcomes, titles, the list with sources and filter, the kinds summary), `tests/errands/errands-ui.test.tsx`
(the screen, the filter and period, Russian), `tests/ui-project-nav.test.tsx` (the rail item).
