import type { ServerCore } from "./core";
import type { Services } from "./services";

/**
 * What the node executors of a chain run (agent, action, human, lp-task) need from the PM chat that started it. It is the
 * `runtime` of `engine.start`; after a reload the engine rebuilds it from the run row (`chainRuntimeFor`, workflow-executors.ts)
 * because the chat, the project and the Lane Pilot run are all in the row.
 */
export type ChainRuntime = {
  ctx: ServerCore; services: Services;
  /** The PM chat that asked for the run: helper threads are its children and answers go to it. */
  pmThreadId: string;
  projectId: string;
  /** The Lane Pilot run (`lane_pilot_run`) of that chat: settings scopes, helper placement, budget. */
  runId: string;
};
