import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrepareRecipient } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { requirePmRun } from "../../../platform/server";
import { latestRunForPmThread } from "../../../storage";
import { startChildPm } from "./child-pm";

const UNOPENED_MS = 5 * 60 * 60_000;
const placementSchema = z.object({
  folders: z.array(z.object({ id: z.string(), projectId: z.string() })),
  bindings: z.record(z.string(), z.string()), places: z.record(z.string(), z.string()),
});
const replacementSchema = z.object({ state: z.enum(["starting", "ready"]), threadId: z.string().optional(), operationId: z.string() });

/** One resolver shared by handoff/ask. The durable starting marker prevents blind retries after a lost spawn response. */
export function createRecipientResolver(ctx: ServerCore): PrepareRecipient {
  const { bb } = ctx;
  // Separate from serializedKv: creating a native profile uses that queue itself.
  let chain: Promise<unknown> = Promise.resolve();
  return (input) => {
    const work = chain.then(async () => {
      if (ctx.isDisposed()) throw new Error("Lane Pilot is stopping");
      const key = `recipient-replacement:${createHash("sha256").update(JSON.stringify([input.projectId, input.fromThreadId, input.toThreadId])).digest("hex")}`;
      const saved = await bb.storage.kv.get(key);
      const prior = saved == null ? null : replacementSchema.parse(saved);
      if (prior?.state === "starting") throw new Error(`recipient setup ${prior.operationId} is unconfirmed${prior.threadId ? ` (@thread:${prior.threadId})` : ""}; inspect it before retrying, do not create another child`);
      const targetId = prior?.threadId ?? input.toThreadId;
      const target = await bb.sdk.threads.get({ threadId: targetId });
      if (!target || target.id !== targetId || !target.projectId || target.deletedAt) throw new Error("recipient thread is unavailable");
      const openedAt = target.lastReadAt ?? target.createdAt;
      if (!Number.isFinite(openedAt) || openedAt <= 0) throw new Error("recipient opening time is unknown");
      const now = Date.now();
      let stale = Boolean(target.archivedAt) || now - openedAt > UNOPENED_MS;
      if (!stale) {
        const events = await bb.sdk.threads.events.list({ threadId: targetId, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" });
        if (!Array.isArray(events)) throw new Error("recipient cache observation is unavailable");
        const last = events[0];
        const ttl = last?.type === "thread/tokenUsage/updated" ? last.data.tokenUsage.promptCacheTtlMs : undefined;
        // A provider with no TTL reports unknown cache state, not an expired cache. The five-hour rule still applies.
        stale = typeof ttl === "number" && ttl > 0 && Number.isFinite(last?.createdAt) && now >= last!.createdAt + ttl;
      }
      if (ctx.isDisposed()) throw new Error("Lane Pilot is stopping");
      if (!stale) return targetId;

      const run = latestRunForPmThread(ctx.db, input.fromThreadId);
      requirePmRun(ctx.db, { runId: run?.id ?? "", threadId: input.fromThreadId, projectId: input.projectId });
      const placement = await bb.sdk.plugins.callRpc({ pluginId: "project-folders", method: "list", input: null, outputSchema: placementSchema });
      const sectionId = Object.hasOwn(placement.places, targetId) ? placement.places[targetId] : target.environmentId ? placement.bindings[target.environmentId] : undefined;
      if (sectionId && !placement.folders.some((f) => f.id === sectionId && f.projectId === target.projectId)) throw new Error("recipient section cannot be verified in its project");
      const environment = target.environmentId ? await bb.sdk.environments.get({ environmentId: target.environmentId }) : null;
      if (environment && environment.projectId !== target.projectId) throw new Error("recipient environment does not belong to its project");
      // A manually filed chat can work elsewhere. Keep its explicit folder, choosing only one of that folder's own paths.
      const sections = sectionId ? await ctx.listProjectSections(target.projectId) : [];
      const section = sections.find((s) => s.id === sectionId);
      const project = sectionId ? null : await bb.sdk.projects.get({ projectId: target.projectId });
      const paths = section ? section.paths : project?.sources ?? [];
      const place = environment ? paths.find((p) => p.hostId === environment.hostId && p.path === environment.path) : undefined;
      if (sectionId === undefined && !place) throw new Error("recipient project/section placement is unknown");
      if (ctx.isDisposed()) throw new Error("Lane Pilot is stopping");
      requirePmRun(ctx.db, { runId: run!.id, threadId: input.fromThreadId, projectId: input.projectId });
      const operationId = `recipient-${randomUUID()}`;
      await bb.storage.kv.set(key, { state: "starting", operationId });
      const opened = await startChildPm(ctx, { projectId: target.projectId, parentThreadId: input.fromThreadId,
        sectionId: sectionId || undefined, ...(place ? { hostId: place.hostId, path: place.path } : {}),
        title: target.title || target.titleFallback || "Pilot continuation", handoffId: operationId });
      await bb.storage.kv.set(key, { state: "starting", operationId, threadId: opened.threadId });
      // An explicit root placement must not be replaced by a natural folder binding.
      if (!sectionId) await bb.sdk.plugins.callRpc({ pluginId: "project-folders", method: "thread_place",
        input: { threadId: opened.threadId, projectId: target.projectId, folderId: null }, outputSchema: z.object({ ok: z.literal(true) }) });
      await bb.storage.kv.set(key, { state: "ready", operationId, threadId: opened.threadId });
      if (ctx.isDisposed()) throw new Error("Lane Pilot is stopping; recipient was prepared, assignment not sent");
      return opened.threadId;
    });
    chain = work.catch(() => undefined);
    return work;
  };
}
