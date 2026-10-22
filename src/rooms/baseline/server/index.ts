// Public API of baseline/server: what other rooms import. Everything else in this room is private.
import type { ServerCore, Services } from "../../core/server";
import { createBaseline } from "./baseline";
import { createRegression } from "./regress";

export { BASELINE_USAGE, runBaselineCli } from "./cli";
export type { BaselineApi } from "./baseline";
export { mountRegress } from "./regress";
export type { ProjectPass, RegressOptions, RegressResult, RegressionApi } from "./regress";
export { baselineRpc } from "./rpc";

/** Both halves on one services bag: `baseline` before a writer starts, `regression` after work is accepted. */
export function createBaselineRoom(ctx: ServerCore, services: Services) {
  return { ...createBaseline(ctx, services), ...createRegression(ctx, services) };
}
