import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  actionsLogInput, actionsLogOutput, attemptLogTailInput, attemptLogTailOutput, brakesGetInput, brakesGetOutput,
  consoleOverviewInput, consoleOverviewOutput, deskGetInput, deskGetOutput, docsProjectsInput, docsProjectsOutput,
  emptyRpcInput, helperThreadLabelsInput, helperThreadLabelsOutput, listHelperThreadsInput, listHelperThreadsOutput,
  manualModeGetInput, manualModeGetOutput, moneyStatusOutput, ownerWaitingOutput, taskBoardInput, taskBoardOutput,
  threadLiveInput, threadLiveOutput, workGraphStripsInput, workGraphStripsOutput, workGraphTaskInput,
  workGraphTaskOutput, uiVersionOutput,
} from "../../contracts/ui";

/**
 * Contract for the UI's watched reads. Every method carries the same input schema the server contract
 * declares (src/rooms/contracts/ui-query-schemas.ts — zod-only, the single home both sides import). Entity tags mark what a change
 * invalidates: the server calls `bb.rpc.experimental_invalidate` where the data is written (attempt
 * transitions, helper thread events and owner-item mutations in platform/server/realtime.ts and the
 * owner-waiting RPC), so an open panel re-reads on the change instead of only on its slowed safety poll.
 * The poll stays as the fallback for a BB without invalidate or watched queries.
 */
export const uiQueryContract = defineRpcContract({
  attempt_log_tail: {
    input: attemptLogTailInput,
    output: attemptLogTailOutput,
    tags: (input) => [`task-board:${input.projectId ?? "all"}`],
  },
  helper_thread_labels: { input: helperThreadLabelsInput, output: helperThreadLabelsOutput },
  list_helper_threads: {
    input: listHelperThreadsInput,
    output: listHelperThreadsOutput,
    tags: (input) => [`helpers:${input.threadId}`],
  },
  money_status: { input: emptyRpcInput, output: moneyStatusOutput, tags: () => ["money_status"] },
  owner_waiting: { input: emptyRpcInput, output: ownerWaitingOutput, tags: () => ["owner_waiting"] },
  task_board: {
    input: taskBoardInput,
    output: taskBoardOutput,
    tags: (input) => [`task-board:${input.projectId ?? "all"}`],
  },
  thread_live: {
    input: threadLiveInput,
    output: threadLiveOutput,
    tags: (input) => [`thread-live:${input.threadId}`],
  },
  work_graph_strips: { input: workGraphStripsInput, output: workGraphStripsOutput, tags: () => ["work-graph"] },
  work_graph_task: { input: workGraphTaskInput, output: workGraphTaskOutput, tags: () => ["work-graph"] },
  ui_version: { input: emptyRpcInput, output: uiVersionOutput, tags: () => ["ui_version"] },
  console_overview: {
    input: consoleOverviewInput,
    output: consoleOverviewOutput,
    tags: (input) => [
      "helpers",
      "owner_waiting",
      `task-board:${input.projectId ?? "all"}`,
      "money_status",
      "work-graph",
    ],
  },
  brakes_get: { input: brakesGetInput, output: brakesGetOutput, tags: () => ["brakes"] },
  manual_mode_get: { input: manualModeGetInput, output: manualModeGetOutput, tags: () => ["manual_mode", "brakes"] },
  docs_projects: { input: docsProjectsInput, output: docsProjectsOutput, tags: () => ["docs_projects"] },
  desk_get: { input: deskGetInput, output: deskGetOutput, tags: () => ["owner_waiting", "review-desk"] },
  actions_log: {
    input: actionsLogInput,
    output: actionsLogOutput,
    tags: (input) => [`actions_log:${input.projectId ?? "all"}`],
  },
});
