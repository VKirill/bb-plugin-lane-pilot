import type { ServerCore } from "../../contracts/server";

import type { PhaseReactions } from "./reactions";


import type { RegressionApi } from "../../baseline/server/regress";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { RunGoalApi } from "../../run-goal/server/run-goal";
import type { WallLoopPort } from "../../contracts";
import type { ArchitectApi, DispatchWriter, ReadWriterWorkspaceFile, RecheckPlanFact, WorkflowEngineApi, WorkflowLibraryApi, WriterStateApi } from "../../platform/server";



import type { DocsNightlyApi } from "../../docs/server/docs-nightly";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  architect: ArchitectApi;
  dispatchWriter: DispatchWriter;
  docsPlaces: DocsNightlyApi["docsPlaces"];
  readWriterWorkspaceFile: ReadWriterWorkspaceFile;
  regression: RegressionApi;
  rollback: RollbackApi;
  recheckPlanFact: RecheckPlanFact;
  runBudgets: WriterStateApi["runBudgets"];
  runGoal: RunGoalApi;
  wall: WallLoopPort;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowLibrary: WorkflowLibraryApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

export class PhaseRefusal extends Error {
  constructor(message: string, readonly why: string[] = []) { super(message); }
}

/** A stage's name in the owner's words (the rows on «Ждут владельца» and the wall's subject). */
export const STAGE_RU: Record<string, string> = { discussion: "обсуждение", planning: "планирование", design: "проектирование", execution: "исполнение", lessons: "уроки" };

/**
 * What every piece of the phase driver starts from: the core, the services bag, the phase's own clock and the reactions
 * handed in by the composition root. Each installer takes this plus exactly the pieces installed before it, so a wrong
 * install order is a type error — there is no shared bag to assign into.
 */
export type DriverBase = {
  ctx: ServerCore;
  services: Services;
  db: ServerCore["db"];
  bb: ServerCore["bb"];
  now: () => number;
  reactions: PhaseReactions;
};
