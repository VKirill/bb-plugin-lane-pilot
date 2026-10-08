import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * The core aborts an isolated run at its time limit (and on reload) but keeps the run's slot until the function
 * returns, so a body stuck on one await held its schedule, and with enough of them every isolated schedule, until the
 * next reload (review 2026-10-07, bug 7). The run's signal is therefore (1) raced against the whole body, so the slot
 * is freed the moment the core aborts, (2) handed to the body for checks between steps, and (3) kept as the ambient
 * signal of the run, which the host call wrapper puts on every host call made inside it.
 */
const runSignal = new AsyncLocalStorage<AbortSignal>();
/** The signal of the isolated schedule run this code is running in; undefined outside one. */
export const currentScheduleSignal = (): AbortSignal | undefined => runSignal.getStore();

/** Why an aborted run stopped: the core's reason (its time limit text) when it gave one. */
export function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "schedule run aborted");
}

/** Rejects when the signal aborts; the work it abandons keeps running but can no longer hold anything. */
export async function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); throw abortReason(signal); }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(abortReason(signal)); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); void work.catch(() => undefined); }
}

export const isolatedSchedulesSupported = (bb: BbPluginApi) =>
  typeof (bb.background as unknown as { experimental_vkSchedule?: unknown }).experimental_vkSchedule === "function";

export function scheduleIsolated(bb: BbPluginApi, name: string, cron: string, work: ScheduleWork, options: { timeoutMs: number; fallback?: ScheduleWork }): void {
  const vk = (bb.background as unknown as { experimental_vkSchedule?: VkSchedule }).experimental_vkSchedule;
  if (typeof vk === "function") {
    vk.call(bb.background, name, cron, async ({ signal }) => {
      await runSignal.run(signal, () => abortable(signal, Promise.resolve().then(() => work(signal))));
    }, { isolated: true, timeoutMs: options.timeoutMs, overlap: "skip" });
    return;
  }
  const plain = options.fallback ?? work;
  bb.background.schedule(name, cron, (() => plain()) as never);
}
