# Workflow triggers (W9)

A workflow starts four ways. Every one of them goes through the same checks as the PM's `lane_pilot_run_workflow`: the workflow
is runnable, its required inputs are whole, what it `requires` exists (W8), and the project has an open Lane Pilot PM chat to
give helper threads and questions a parent. The code is `src/server/workflow-triggers.ts` (`start`).

| Trigger | Who starts it | How |
| --- | --- | --- |
| `chat` | the PM | `lane_pilot_route` picks the workflow, `lane_pilot_run_workflow` starts it. Only published workflows are offered. Between alike matches the router prefers the one that has run well and lately (`STAT_WEIGHT` 0.02, never over a better text match). |
| `manual` | the owner | **Run** in the Workflows tab: a form for the workflow's inputs, then RPC `workflow_run`. A `tested` workflow shows **Run for real**: the first live run, and one success makes it published. |
| `schedule` | BB automations | see below |
| `telegram` | another plugin | see below |

## Schedule

```json
"triggers": [{ "type": "schedule", "cron": "0 9 * * 1-5", "timezone": "Europe/Moscow", "projectId": "proj_...", "inputs": { "query": "cats" } }]
```

`cron` has five fields (minute hour day-of-month month day-of-week); `timezone` is an IANA name (the hub's own when absent);
`projectId` is the project whose PM chat runs it (a project workflow uses its own project); `inputs` are the values of every
scheduled run. A schedule without a cron creates nothing (it only says the workflow can be scheduled); a broken cron or zone is a validator warning and creates nothing.

Lane Pilot keeps one BB **script automation** per schedule trigger of an own (global or project), **published** workflow.
`syncSoon(projectId)` runs after a publish from the architect or the editor, after **Run tests**, and every hour for the projects
that have a schedule. It creates the automation, updates it when the cron, zone, inputs or version changed, makes it again when
the owner deleted it, and removes it when the workflow is unpublished, deprecated, lost the trigger or went back to a draft (a file
edited by hand has no green test receipt and counts as a draft). While the project's own files cannot be read, nothing that merely
went missing from the list is removed. The built-in workflows are never scheduled; the table `lane_pilot_wf_trigger` holds the link.

The automation's script is one line:

```bash
bb lane-pilot workflow-trigger "$BB_PROJECT_ID" '<workflow id>' '<inputs json>' "$BB_AUTOMATION_RUN_ID"
```

The tick's run id is the key, so BB's retry of a tick is the same workflow run. The command exits 1 with the reason when the
workflow cannot start (no PM chat, a missing requirement, a missing input): the automation then shows a failed run, and BB
pauses it after three failures in a row.

## Telegram: the hook point

`bb-plugin-telegram-projects` has no workflow command yet, so there is no Telegram trigger of its own. Today a message in a
project's topic reaches the PM chat as an ordinary message, and the PM routes it (`chat`). The hook for a direct start exists on
this side: RPC `workflow_run` with `source: "telegram"` starts a workflow that lists `{ "type": "telegram" }` in its triggers
(and refuses any other with `no_trigger`). To wire it, add a command to `BOT_COMMANDS` in `telegram-projects/commands.ts`
(for example `/run <workflow> [inputs]`) whose handler calls

```ts
bb.sdk.plugins.callRpc({ pluginId: "lane-pilot", method: "workflow_run", input: { id, projectId, inputs, source: "telegram" }, outputSchema })
```

and answers the owner with the run id or the `message` of a refusal.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Schedule board: Lane Pilot's own scheduler](schedule-board.md)
