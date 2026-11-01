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

1. *Kinds and their models*: one line per kind (`computer`, `devops`, `browser`, `research`, `message`, no kind), what it is, the model in force at
   the global level with the role row under it (`errand-computer` … `errand`; «your row» when the owner set it, «built-in default» otherwise), and
   the period's runs, done, stopped, failed, cost, and how often Jev in shadow would have named the kind. The model is edited where every role is:
   General settings → Team → Models by role.
2. *Errands of the last N days* (7, 30, 90; a kind filter): when, project, the errand's title (the title it was given, else the first line of its
   brief), its kind and who named it (PM, the brief, Jev, the schedule), the model, the outcome, who asked (the PM chat or the schedule by name;
   «deleted» when the schedule is gone), the cost, and «Open the chat» for the helper's thread (the same side panel every helper opens in).

**The read model** (`src/rooms/errands/logic.ts`; RPC `errands_overview` in `src/rooms/errands/server/rpc.ts`, contract `rpc-ops.ts`) reads the
workflow journal only, no table of its own: the kind, model and source from `inputs_json` (`kind`, `kindBy`, `providerId`, `model`, `scheduleId`),
the verdict from `output_json`, the helper thread from the `errand.spawn` effect, the PM chat from the linked run's `pm_thread_id`, the schedule's
name from `lane_pilot_schedule`, the cost from the run's `cost_micro_usd`. The outcome is one of five words: *in progress*, *done* (`state: done`),
*stopped* (`state: blocked` with the helper's reason), *failed* (the run failed), *cancelled* (a canceled run, or a helper the owner stopped: its
reason says `cancel`, the same rule `schedule-service.ts` uses to post no owner row). A new kind is a row in `src/rooms/schedule/errand-kinds.ts`
and appears on the page by itself.

**Tests.** `tests/errands/errands-logic.test.ts` (outcomes, titles, the list with sources and filter, the kinds summary), `tests/errands/errands-ui.test.tsx`
(the screen, the filter and period, Russian), `tests/ui-project-nav.test.tsx` (the rail item).
