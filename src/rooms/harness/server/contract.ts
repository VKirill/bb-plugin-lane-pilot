import type { StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime } from "../../contracts/server";
import type { GraphHelperRun } from "../../platform/server";
import type { WorkflowEngineApi, WriterHostApi } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

/** The graphs that run the model work of the harness: an improvement round for a key (prepare, edit, validate) and the reflection on a decided trial. */
export const HARNESS_EDIT_WORKFLOW = "lp.harness-edit";
export const HARNESS_REFLECT_WORKFLOW = "lp.harness-reflect";
/** Runs one helper thread of a graph step (workflow/server's `runGraphHelper` bound to the step); passed in so this room does not import the workflow room's server. */
export type GraphHelperFn = (input: { key: string; spawn: (graph: { spawnId: string; metadata: Record<string, unknown> }) => Promise<string>; waitMs?: number; label: string; projectId: string | null; archive?: boolean }) => Promise<GraphHelperRun>;
export type HarnessStep = { c: StepContext<ChainRuntime>; helper: GraphHelperFn; runs: GraphHelperRun[] };

/** The second editor of a round starts this much later than the first (OpenCode startup holds its database). */
const EDITOR_STAGGER_MS = 15_000;
/** The waits of a round, in one place so a test can shorten them: the second editor starts later, and a session that ended early is retried after a pause. */
export const HARNESS_TUNING = { editorStaggerMs: EDITOR_STAGGER_MS, retryDelayMs: 20_000 };
