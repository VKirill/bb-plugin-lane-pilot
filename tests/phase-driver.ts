import type { ServerCore } from "../src/rooms/contracts/server";
import type { Services } from "../server";
import { createPhaseDriver as createDriver } from "../src/rooms/phase/server/driver";
import { createPhaseReactions } from "../src/rooms/core/server";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { issueQuickModelCalls, issueQuickShortPath, issueQuickWorkflowId } from "../src/rooms/workflow/short-path";
import { stageHelperSettings } from "../src/rooms/settings/server/stage-settings";

/** The composition root's phase driver for tests: the bag gets the fields the driver reads that a bare
 * test bag does not name (the workflow pickers and the stage settings), and a fake engine learns
 * resolveWorkflow the way the real one exposes it. */
export function createPhaseDriver(ctx: ServerCore, services: Services) {
  const bag = services as Partial<Services>;
  bag.stageHelperSettings ??= stageHelperSettings;
  bag.workflowLibrary ??= { issueQuickWorkflowId, issueQuickModelCalls, issueQuickShortPath, loadStore: async () => ({ store: { list: () => [], get: () => null } }) } as never;
  bag.workflowEngine ??= {
    resolveWorkflow: (id: string) => builtinWorkflow(id),
    snapshot: () => null, get: () => null,
    start: () => ({ runId: "wf_fake", created: true, done: new Promise(() => undefined) }),
  } as never;
  const engine = bag.workflowEngine as { resolveWorkflow?: unknown } | undefined;
  if (engine && typeof engine.resolveWorkflow !== "function" && !("journal" in engine)) {
    engine.resolveWorkflow = (id: string) => builtinWorkflow(id);
  }
  return createDriver(ctx, services, createPhaseReactions(ctx.db, ctx.bb));
}
