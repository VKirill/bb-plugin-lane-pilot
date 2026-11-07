import type { ServerCore } from "../../contracts/server";

import { realDeps } from "./workflow-architect";
import { createWorkflowLibrary } from "./workflow-library";
import { createWorkflowPreflight } from "./workflow-preflight";
import { automationsOverRpc, createWorkflowTriggers } from "./workflow-triggers";


import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { WorkflowEngineApi } from "../../platform/server";
import type { DispatchWriter } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  dispatchWriter: DispatchWriter;
  docsPlaces: DocsNightlyApi["docsPlaces"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

/**
 * The triggers of this plugin instance, wired to its library, its requirements check and BB's automations. A service of the bag
 * (`services.workflowTriggers`) so the publish, the tests and the sweep share one in-flight guard per project.
 */
export function createWorkflowTriggersService(ctx: ServerCore, services: Services) {
  const library = createWorkflowLibrary(ctx, services);
  const preflight = createWorkflowPreflight(ctx, realDeps(ctx, services));
  const triggers = createWorkflowTriggers(ctx, services, {
    loadStore: (projectId) => library.loadStore(projectId),
    preflight: (workflow, input) => preflight.check(workflow, input),
    automations: automationsOverRpc(ctx),
  });
  const running = new Set<string>(), again = new Set<string>();

  /** Syncs a project's schedules in the background: one at a time per project, one more after it when asked again meanwhile. Never throws. */
  function syncSoon(projectId: string): void {
    if (running.has(projectId)) { again.add(projectId); return; }
    running.add(projectId);
    void triggers.sync(projectId)
      .catch((cause: unknown) => ctx.log(`Lane Pilot workflow schedules not synced for ${projectId}: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => { running.delete(projectId); if (again.delete(projectId)) syncSoon(projectId); });
  }

  /** Every project that has a schedule from this plugin: the sweep re-checks them, so a file edited outside the tab loses or gains its schedule within the hour. */
  const scheduledProjects = (): string[] => (ctx.db.prepare("SELECT DISTINCT project_id FROM lane_pilot_wf_trigger").all() as Array<{ project_id: string }>).map((row) => row.project_id);

  return { workflowTriggers: { ...triggers, syncSoon, scheduledProjects } };
}

export type WorkflowTriggersApi = ReturnType<typeof createWorkflowTriggersService>;
