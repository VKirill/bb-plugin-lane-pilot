import type { ServerCore } from "../../../contracts/server";
import { wfScheduledProjectIds } from "@lane-pilot/workflow-engine";

import { realDeps } from "./workflow-architect";
import { createWorkflowLibrary } from "./workflow-library";
import { createWorkflowPreflight } from "./workflow-preflight";
import { createWorkflowTriggers, type ScheduleBoardPort } from "./workflow-triggers";


import type { DocsApi } from "../../../docs/server";
import type { WorkflowEngineApi } from "../../../platform/server";
import type { DispatchWriter } from "../../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  dispatchWriter: DispatchWriter;
  docsPlaces: DocsApi["docsPlaces"];
  schedules?: ScheduleBoardPort;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

/**
 * The triggers of this plugin instance, wired to its library, its requirements check and the schedule board. A service of the bag
 * (`services.workflowTriggers`) so publish, edit, tests and startup share one in-flight guard per project.
 */
export function createWorkflowTriggersService(ctx: ServerCore, services: Services) {
  const library = createWorkflowLibrary(ctx, services);
  const preflight = createWorkflowPreflight(ctx, realDeps(ctx, services));
  const triggers = createWorkflowTriggers(ctx, services, {
    loadStore: (projectId) => library.loadStore(projectId),
    preflight: (workflow, input) => preflight.check(workflow, input),
    scheduleBoard: {
      save: (raw, by) => services.schedules
        ? services.schedules.save(raw, by)
        : Promise.resolve({ ok: false as const, problems: ["schedule board unavailable"] }),
      remove: (id) => services.schedules ? services.schedules.remove(id) : false,
    },
  });
  const running = new Map<string, Promise<void>>(), again = new Set<string>();

  /** Every project that has a schedule from this plugin. */
  const scheduledProjects = (): string[] => wfScheduledProjectIds(ctx.db);

  /**
   * Syncs schedule triggers to the schedule board for one project, or for all scheduled and known projects when omitted.
   * Coalesces concurrent calls per project and never throws.
   */
  async function syncTriggers(projectId?: string): Promise<void> {
    if (!projectId) {
      const projects = new Set<string>(scheduledProjects());
      const listed = await ctx.bb.sdk.projects?.list?.({ includePersonal: true }).catch(() => []) ?? [];
      for (const project of listed) if (project?.id) projects.add(project.id);
      for (const id of projects) await syncTriggers(id);
      return;
    }
    const active = running.get(projectId);
    if (active) { again.add(projectId); await active; return; }
    const task = (async () => {
      try {
        await triggers.sync(projectId);
      } catch (cause: unknown) {
        ctx.log(`Lane Pilot workflow schedules not synced for ${projectId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        running.delete(projectId);
      }
      if (again.delete(projectId)) await syncTriggers(projectId);
    })();
    running.set(projectId, task);
    await task;
  }

  return { workflowTriggers: { ...triggers, preflight: preflight.check, syncTriggers, scheduledProjects } };
}

export type WorkflowTriggersApi = ReturnType<typeof createWorkflowTriggersService>;
