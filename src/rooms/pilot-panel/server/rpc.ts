import { bestEffort, isNotFound, orMiss } from "@lane-pilot/kit";
import type { ActivationApi } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import type { PilotDelegationChoice } from "../index";
import { materializeProjectPilotSetup, type ProjectPilotBootstrapResult } from "./project-skills";
import { createPilotPanelService } from "./service";

/**
 * Idempotent project preparation invoked automatically when Lane Pilot activates on a checkout:
 * installs/updates standardized Pilot skills in `<workspacePath>/.bb/skills/` and initializes
 * `.agents/pilot/` + `AGENTS.md` managed context without overwriting owner files.
 */
export async function bootstrapProjectForPilot(
  ctx: Pick<ServerCore, "bb" | "log">,
  input: { projectId: string; hostId: string; workspacePath: string },
): Promise<ProjectPilotBootstrapResult | null> {
  let projectName: string | null = null;
  if (typeof ctx.bb.sdk.projects?.get === "function") {
    const proj = await orMiss(ctx.bb.sdk.projects.get({ projectId: input.projectId }), null, isNotFound) as { name?: unknown } | null;
    if (typeof proj?.name === "string") projectName = proj.name;
  }
  return bestEffort(
    ctx.bb.log,
    `pilot auto-bootstrap ${input.projectId}`,
    materializeProjectPilotSetup(ctx, {
      hostId: input.hostId,
      rootPath: input.workspacePath,
      projectName,
      onlyIfUnconfigured: true,
      preserveExistingAgentsMd: true,
    }),
    null,
  );
}

export function pilotPanelRpc(ctx: ServerCore, deps: { activate?: ActivationApi["activate"] } = {}) {
  const service = createPilotPanelService(ctx, deps);
  try {
    const events = (ctx.bb as { events?: { on?: (event: string, cb: (payload: { thread?: { id?: string; parentThreadId?: string | null } }) => void) => void } }).events;
    const realtime = (ctx.bb as { realtime?: { publish?: (event: string, payload: unknown) => void } }).realtime;
    if (typeof events?.on === "function" && typeof realtime?.publish === "function") {
      for (const evt of ["thread.active", "thread.idle", "thread.failed"]) {
        events.on(evt, ({ thread }) => {
          if (thread?.id) realtime.publish!("pilot-panel-changed", { threadId: thread.id });
          if (thread?.parentThreadId) realtime.publish!("pilot-panel-changed", { threadId: thread.parentThreadId });
        });
      }
    }
  } catch {
    // Event subscription is best-effort in minimal test hosts.
  }
  return {
    pilot_panel_status: (input: { threadId: string; targetPlan?: string; force?: boolean }) =>
      service.status(input),
    pilot_panel_prepare_project: (input: { threadId: string }) =>
      service.prepareProject(input.threadId),
    pilot_panel_set_delegation: (input: { threadId: string; choice: PilotDelegationChoice }) =>
      service.setDelegation(input.threadId, input.choice),
    pilot_panel_set_readiness_skip: (input: { threadId: string; stepId: "quality" | "ci"; skipped: boolean }) =>
      service.setReadinessSkip(input.threadId, input.stepId, input.skipped),
    pilot_panel_run_action: (input: {
      threadId: string;
      actionId: string;
      targetPlan?: string;
      fingerprint: string;
      requestId: string;
    }) => service.runAction(input),
  };
}
