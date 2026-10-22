import { setTimeout as sleep } from "node:timers/promises";
import type { ServerCore } from "../../core/server";
import { stringAt } from "../../core/server";

/**
 * «Stopped» has two conditions (SMA wall 3, rule 9): the writer's process is confirmed gone, and its work is back. The first
 * is this: after `threads.stop` the thread is asked until it is neither active nor listed as running, for a bounded time. A
 * single look right after the stop used to read a writer that was still winding down as «not observed» and left the attempt
 * in `cancel_requested`. The second is `rollback.noteStopped` (the worktree state is written down before any cleanup).
 */
export const STOP_CONFIRM_MS = 30_000;

export async function confirmWriterStopped(bb: ServerCore["bb"], threadId: string, options: { waitMs?: number; pollMs?: number } = {}):
  Promise<{ stopped: boolean; status: string | null; waitedMs: number }> {
  const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>> }).listRunning;
  const startedAt = Date.now();
  const deadline = startedAt + (options.waitMs ?? STOP_CONFIRM_MS);
  for (;;) {
    const observed = await bb.sdk.threads.get({ threadId });
    const status = stringAt(observed, "status");
    const running = listRunning ? await listRunning({}) : [];
    const stillRunning = running.some((thread) => thread.id === threadId) || status === "active" || status === "running";
    if (!stillRunning) return { stopped: true, status, waitedMs: Date.now() - startedAt };
    if (Date.now() >= deadline) return { stopped: false, status, waitedMs: Date.now() - startedAt };
    await sleep(options.pollMs ?? 1_000);
  }
}
