import { countWaitingSteps } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { scheduleIsolated, type WorkflowEngineApi } from "../../../platform/server";
import type { ScheduleService } from "../services/schedule-service";

/**
 * Starts the engine's one clock for the plugin: a single timer to the nearest waiting-step deadline or due board row, backed by the
 * one core isolated schedule (`engine-clock`), held by the board-wide pause, stamping the outage beat (`onBeat`) at every tick.
 */
export async function startBoardClock(
  ctx: Pick<ServerCore, "bb">,
  services: { schedules: ScheduleService } & WorkflowEngineApi,
  onBeat: (at: number) => void,
): Promise<void> {
  const { pause, board, store, scheduler } = services.schedules;
  await pause.load().catch((cause: unknown) => ctx.bb.log.warn(`Lane Pilot: board pause not read: ${cause instanceof Error ? cause.message : String(cause)}`));
  const clock = services.workflowEngine.startClock({ board, isPaused: pause.isPaused, onBeat });
  // One core schedule (`bb plugin list` shows 1): runs engine clock ticks alongside the event-driven timer.
  scheduleIsolated(ctx.bb, "engine-clock", "* * * * *", () => clock.tick().then(() => undefined), { timeoutMs: 60_000 });
  ctx.bb.onDispose(() => clock.stop());
  if (!pause.isPaused() && store.unfinishedRuns().length > 0) scheduler.kick();
  const waitingSteps = countWaitingSteps(services.workflowEngine);
  const calendarRows = store.list({ states: ["active"] }).length;
  ctx.bb.log.info(`Lane Pilot clock: scheduler=engine-clock timers=1, ${waitingSteps} waiting steps, ${calendarRows} calendar rows`);
}
