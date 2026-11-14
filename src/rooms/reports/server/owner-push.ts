import type { TelegramSend } from "./telegram";

/**
 * «Ждут владельца» → Telegram, as a plugin schedule (it was ~/.config/lp-metrics/owner-push.sh in the hub's crontab).
 * The decisions are owner-waiting's (src/rooms/owner-waiting/push.ts: wake items only, one message per waiting, quiet hours, at most six lines);
 * this only carries the text. The keys are acknowledged only after a successful send, so a failed send is offered again at the next tick.
 * With `dry_run=on` (`bb lane-pilot waiting config dry_run=on`) the text is composed and logged, nothing is sent and nothing is acknowledged.
 */
export type DigestLike = { send: boolean; reason: string | null; text: string; keys: string[] };
export type OwnerPushOutcome = { status: "idle" | "sent" | "dry_run" | "failed"; reason?: string };

export async function runOwnerPush(deps: {
  digest: () => Promise<DigestLike>;
  ack: (keys: string[]) => unknown;
  send: TelegramSend;
  dryRun: () => boolean;
  log: (message: string) => void;
}): Promise<OwnerPushOutcome> {
  const digest = await deps.digest();
  if (!digest.send) return { status: "idle", reason: digest.reason ?? undefined };
  if (deps.dryRun()) { deps.log(`owner push (dry run, not sent, not acknowledged):\n${digest.text}`); return { status: "dry_run" }; }
  try { await deps.send(digest.text); }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    deps.log(`owner push: not sent (${reason}); the keys stay unacknowledged and the next tick tries again`);
    return { status: "failed", reason };
  }
  try { deps.ack(digest.keys); }
  catch (cause) { deps.log(`owner push: sent, but the acknowledgement failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  return { status: "sent" };
}
