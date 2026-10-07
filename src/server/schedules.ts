import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * VK core isolated schedules (`bb.background.experimental_vkSchedule`). BB runs the due schedules of every plugin one
 * after another and waits for each; on 2026-10-03 one long Lane Pilot schedule held its own self-repair and other
 * plugins' schedules back for 50 minutes. An isolated schedule starts without being waited for, runs at most once at a
 * time (a tick that comes while it still runs is skipped) and is aborted with an error result after `timeoutMs`.
 * Without the function it is the ordinary `bb.background.schedule`, as before.
 */
type VkSchedule = (name: string, cron: string, fn: (context: { signal: AbortSignal }) => unknown, options: { isolated: boolean; timeoutMs: number; overlap: "skip" }) => void;
type ScheduleWork = (signal?: AbortSignal) => unknown;

export const isolatedSchedulesSupported = (bb: BbPluginApi) =>
  typeof (bb.background as unknown as { experimental_vkSchedule?: unknown }).experimental_vkSchedule === "function";

export function scheduleIsolated(bb: BbPluginApi, name: string, cron: string, work: ScheduleWork, options: { timeoutMs: number; fallback?: ScheduleWork }): void {
  const vk = (bb.background as unknown as { experimental_vkSchedule?: VkSchedule }).experimental_vkSchedule;
  if (typeof vk === "function") {
    vk.call(bb.background, name, cron, async ({ signal }) => { await work(signal); }, { isolated: true, timeoutMs: options.timeoutMs, overlap: "skip" });
    return;
  }
  const plain = options.fallback ?? work;
  bb.background.schedule(name, cron, (() => plain()) as never);
}
