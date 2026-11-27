import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ManualMode } from "../../../contracts";
import { streamRetryDecision } from "../../models/stream-retry";

export function attachStreamRetry(input: {
  events: BbPluginApi["events"];
  retry: BbPluginApi["sdk"]["threads"]["retry"];
  owned: (threadId: string) => Promise<boolean>;
  failureDetail?: (threadId: string) => Promise<string | null>;
  isDisposed?: () => boolean;
  manualMode?: Pick<ManualMode, "on">;
  now?: () => number;
  info?: (message: string) => void;
  log?: (message: string) => void;
}): void {
  input.events.on("turn.failed", async (event) => {
    if (input.isDisposed?.()) return;
    // «Ручной режим»: never restart failed turns on our own while manual.
    if (input.manualMode?.on()) {
      (input.info ?? input.log)?.(`stream retry skipped for ${event.threadId}: manual mode`);
      return;
    }
    let decision = streamRetryDecision(event);
    if (decision.kind === "decline" && decision.reason === "not-retryable" && input.failureDetail) {
      const detail = await input.failureDetail(event.threadId);
      decision = streamRetryDecision({ ...event, detail });
    }
    if (decision.kind === "decline") return;
    if (!await input.owned(event.threadId)) return;
    if (input.isDisposed?.()) return;
    try {
      await input.retry({
        threadId: event.threadId,
        turnRequestId: event.requestId,
        sendAt: input.now ? input.now() + decision.delayMs : Date.now() + decision.delayMs,
        reason: "Lane Pilot: retry the same turn after a dropped stream",
      });
    } catch (cause) {
      input.log?.(`stream retry failed for ${event.threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
}
