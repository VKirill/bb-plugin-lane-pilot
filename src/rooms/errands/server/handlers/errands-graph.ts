import type { NodeExecutor } from "@lane-pilot/workflow-engine";
import type { ChainRuntime } from "../../../contracts/server";
import type { ErrandGraphService, ErrandsServices } from "../services/errand-graph";

/** Registers the `lp.errand_accounts` and `lp.errand` workflow graph step executors. */
export function registerErrandGraphSteps(services: ErrandsServices, graphService: ErrandGraphService): void {
  const engine = services.workflowEngine;

  engine.register<ChainRuntime>("lp.errand_accounts", {
    reentrant: true,
    run: (c) => graphService.runAccountsStep(c),
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.errand", {
    // Every external call inside runErrandStep is a journal effect or a read, so the step can be run again after a reload.
    reentrant: true,
    run: (c) => graphService.runErrandStep(c),
  } as NodeExecutor<ChainRuntime>);
}
