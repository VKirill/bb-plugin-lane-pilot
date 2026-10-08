import { getAttempt } from "../database";
import { handleNativeDispatch, mentionContext, nativeContributedEnv } from "../native-dispatch";
import { NATIVE_MENTION_PROVIDER, nativeSelectionSchema } from "../native-session";
import { attachStreamRetry, droppedStreamDetail } from "../stream-retry";
import { mountOpencodeMinimal } from "./opencode-minimal";
import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw } from "@lane-pilot/thread-observe";
import type { ServerCore } from "./core";

export function mountNativeWiring(ctx: ServerCore) {
  const { bb, db, nativeHost } = ctx;

  bb.ui.registerMentionProvider({
    id: NATIVE_MENTION_PROVIDER,
    label: "Lane Pilot",
    search: () => [],
    resolve: async (token) => {
      const selected = await bb.storage.kv.get(`native-selection:${token}`);
      if (!selected) {
        bb.log.debug(`native-trace mention.resolve token=${token} reason=selection_missing`);
        throw new Error("Lane Pilot selection is missing. Choose the profile again.");
      }
      const parsed = nativeSelectionSchema.parse(selected);
      bb.log.debug(`native-trace mention.resolve token=${parsed.token} project=${parsed.projectId} reason=ok`);
      return { context: mentionContext(parsed) };
    },
  });

  bb.experimental_hooks.on("message.dispatch", (ctx) => handleNativeDispatch(bb, nativeHost, ctx, db));

  bb.providers.experimental_contributeEnv("claude-code", (ctx) => nativeContributedEnv(bb, nativeHost, ctx));
  mountOpencodeMinimal(ctx);

  attachStreamRetry({
    events: bb.events,
    retry: (args) => bb.sdk.threads.retry(args),
    isDisposed: () => ctx.state.disposed,
    log: (message) => bb.log.warn(message),
    failureDetail: async (threadId) => {
      const listed = await listThreadEventsRaw(bb, {
        threadId, types: THREAD_WATCH_EVENT_TYPES, order: "desc", limit: "50",
      });
      return listed.ok ? droppedStreamDetail(listed.events) : null;
    },
    owned: async (threadId) => {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null);
      const role = metadata && typeof metadata === "object" ? Reflect.get(metadata, "role") : null;
      const runId = metadata && typeof metadata === "object" ? Reflect.get(metadata, "lanePilotRunId") : null;
      const attemptId = metadata && typeof metadata === "object" ? Reflect.get(metadata, "attemptId") : null;
      if (typeof attemptId === "string" && attemptId) {
        const attempt = getAttempt(db, attemptId);
        if (attempt && (attempt.state === "cancel_requested" || attempt.state === "canceled")) return false;
      }
      if ((typeof role === "string" && role) || (typeof runId === "string" && runId)) return true;
      return Boolean(await bb.storage.kv.get(`native-thread:${threadId}`));
    },
  });
}
