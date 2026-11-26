import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { streamRetryDecision } from "../../models/stream-retry";

export function attachStreamRetry(input: {
  events: BbPluginApi["events"];
  retry: BbPluginApi["sdk"]["threads"]["retry"];
  owned: (threadId: string) => Promise<boolean>;
  failureDetail?: (threadId: string) => Promise<string | null>;
  isDisposed?: () => boolean;
  now?: () => number;
  log?: (message: string) => void;
}): void {
  input.events.on("turn.failed", async (event) => {
    if (input.isDisposed?.()) return;
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
