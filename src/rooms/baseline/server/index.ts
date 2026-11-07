// Public API of baseline/server: what other rooms import. Everything else in this room is private.

import type { ServerCore } from "../../contracts/server";
import { createBaseline } from "./baseline";
import { createRegression } from "./regress";


import type { RollbackApi } from "../../rollback/server/rollback";
import type { WorkflowEngineApi } from "../../workflow/server/workflow";

import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { WriterStateApi } from "../../writer/server/state";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  docsLastRead: DocsNightlyApi["docsLastRead"];
  docsPlaceStatus: DocsNightlyApi["docsPlaceStatus"];
  rollback: RollbackApi;
  runWriterPool: WriterStateApi["runWriterPool"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

export { BASELINE_USAGE, runBaselineCli } from "./cli";
export type { BaselineApi } from "./baseline";
export { mountRegress } from "./regress";
export { mountRegressionTools } from "./regression-tools";
export type { ProjectPass, RegressOptions, RegressResult, RegressionApi } from "./regress";
export { baselineRpc } from "./rpc";

/** Both halves on one services bag: `baseline` before a writer starts, `regression` after work is accepted. */
export function createBaselineRoom(ctx: ServerCore, services: Services) {
  return { ...createBaseline(ctx, services), ...createRegression(ctx, services) };
}
