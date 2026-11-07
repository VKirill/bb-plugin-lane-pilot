import type { ServerCore } from "../server-core";

/** The services bag a chain runtime carries; the executors read what they need through it (typed per file). */
export interface ChainRuntimeServices {}

/**
 * What the node executors of a chain run (agent, action, human, lp-task) need from the PM chat that started it. It is the
 * `runtime` of `engine.start`; after a reload the engine rebuilds it from the run row (`chainRuntimeFor`, workflow-executors.ts)
 * because the chat, the project and the Lane Pilot run are all in the row.
 */
export type ChainRuntime = {
  ctx: ServerCore; services: ChainRuntimeServices;
  /**
   * The PM chat that asked for the run: helper threads are its children and answers go to it. Null in a project that does not use
   * Lane Pilot: the helpers are then hidden threads of the project itself, the owner is asked through his list and the end is reported there.
   */
  pmThreadId: string | null;
  projectId: string;
  /** The Lane Pilot run (`lane_pilot_run`) of that chat: settings scopes, helper placement, budget. Null with no PM chat. */
  runId: string | null;
  /** `schedule` when a schedule started the run (the board, or a workflow's schedule trigger): the agents it starts cannot create schedules (schedule-tools.ts). */
  origin?: "schedule";
};
