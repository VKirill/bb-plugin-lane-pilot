import type { ExperimentalHostClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { listQaHosts } from "../platform/server";
import type { ServerCore } from "../contracts/server";
import type { AnamnesisRpcRequest, anamnesisHostMethods, anamnesisRpcMethods } from "./contract";
import { runAnamnesisCli, type CliResult } from "./cli";
import { createHub, type Hub } from "./hub";
import { OWNER_KEY_NAME, parseOwnerKey } from "./crypto";
import { openOwnerStore, type StoreDb } from "./store";
import { fragmentJudgeVia, type FragmentJudge, type FragmentModel } from "./fragments";
import { loadAnamnesis, type LoadDeps, type LoadOptions } from "./load";
import { createOwnerMessageHub, isOwnerThread, sdkThreadsPort, type ThreadLike } from "./owner-messages";
import { createExtractConsumer, type ExtractDeps } from "./extract";
import { bestEffort } from "@lane-pilot/kit";
import { listAllRunRefs } from "../storage";
import { dailyDue, dailyPass, markDailyDone, type DailyDeps } from "./daily";
import { scheduleIsolated } from "../platform/server";

const cache = new WeakMap<object, ReturnType<typeof build>>();

function build(ctx: ServerCore) {
  const { bb, db, host, secrets } = ctx;
  /**
   * The owner tables of the plugin base (M1b): every anamnesis operation runs here. `LP_OWNER_MEMORY_KEY` is fetched
   * from Env Catalog before each ask and never kept anywhere but this closure; without it sensitive records stay closed.
   */
  let ownerKey: Buffer | null = null;
  const refreshOwnerKey = async (): Promise<void> => {
    try { ownerKey = parseOwnerKey((await secrets.record(OWNER_KEY_NAME))?.value ?? null); }
    catch (cause) { bb.log.warn(`anamnesis owner key refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`); ownerKey = null; }
  };
  const store = openOwnerStore(db as unknown as StoreDb, {
    crypto: {
      key: () => ownerKey,
      missing: () => bb.log.warn(`anamnesis owner_key_missing: ${OWNER_KEY_NAME} is not in Env Catalog; sensitive records stay closed`),
    },
  });
  const innerHub: Hub = createHub({
    hostCall: async (hostId, request, timeoutMs) => (await (host as unknown as ExperimentalHostClient<typeof anamnesisHostMethods>).call("anamnesis", { requestedHostId: hostId, request }, { hostId, timeoutMs })).response,
    listHosts: async () => listQaHosts(bb),
    kv: bb.storage.kv as never,
    store,
    log: (message) => bb.log.warn(message),
  });
  /** The hub-side memory catalog for a collect request (A-b2): the memory plugin's RPC answers it; absent, the host's `bb` CLI is the fallback. */
  const callRpc = (bb.sdk as unknown as { plugins?: { callRpc?: (args: { pluginId: string; method: string; input: unknown; outputSchema: { parse(input: unknown): unknown } }) => Promise<unknown> } }).plugins?.callRpc;
  const bbMemories = async () => {
    if (!callRpc) return undefined;
    const output = z.object({ memories: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), summary: z.string().optional(), kind: z.string().optional(), scope: z.string().optional(), tags: z.array(z.string()).optional(), importance: z.number().optional(), version: z.number().optional(), updatedAt: z.number().optional() }).strict()) });
    // The memory plugin is optional: its absence or failure leaves the host's `bb` CLI fallback in place.
    return bestEffort((message) => bb.log.warn(message), "anamnesis bb-memory catalog", callRpc({ pluginId: "memory", method: "listMemories", input: null, outputSchema: output })
      .then((raw) => output.parse(raw))
      .then((reply) => reply.memories.filter((memory) => memory.scope !== "project").slice(0, 200)), undefined);
  };
  const hub: Hub = {
    ...innerHub,
    ask: async (request, timeoutMs) => {
      await refreshOwnerKey();
      const collect = "sources" in request ? request : undefined;
      return innerHub.ask(collect && collect.sources.includes("bb-memory") && collect.bbMemories === undefined
        ? { ...request, bbMemories: await bbMemories() } : request, timeoutMs);
    },
    dispatch: async (request) => {
      await refreshOwnerKey();
      return innerHub.dispatch(request);
    },
  };

  const ownerMessages = createOwnerMessageHub(), threads = sdkThreadsPort(bb as never);
  /**
   * The model that reads masked fragments in batches. It is the rules analyzer of a project, so it is wired by the learning room (which
   * owns the way to reach it) through `setFragmentModel`; until then, and while it is absent, nothing is classified.
   */
  let fragmentJudge: FragmentJudge | undefined;
  const extractDeps: ExtractDeps = { hub, now: Date.now, get judge() { return fragmentJudge; } };
  const consumer = createExtractConsumer(extractDeps);
  ownerMessages.subscribe(consumer);

  const dailyDeps = (): DailyDeps => ({
    hub, threads, owner: ownerMessages, consumer, now: Date.now, log: (message) => bb.log.warn(message),
    projectNames: async () => new Map(((await bb.sdk.projects.list({ includePersonal: true } as never)) as unknown as Array<{ id: string; name?: string }>).map((project) => [project.id, project.name ?? project.id])),
    lpRuns: () => listAllRunRefs(db).map((row) => ({ id: row.id, projectId: row.project_id, createdAt: row.created_at })),
  });
  const runPass = async (signal?: AbortSignal) => {
    const report = await dailyPass(dailyDeps(), { signal });
    if (report.ran) await markDailyDone(hub, Date.now());
    return report;
  };

  /** The at-message path: a thread that went idle may hold new messages of the owner; they take the same filter and consumers as the daily pass. */
  const liveCursor = new Map<string, number>();
  const bootAt = Date.now();
  async function liveMessages(threadId: string): Promise<void> {
    if ((await hub.config()).extract !== true) return;
    const thread = await ctx.getThreadBounded(threadId) as ThreadLike | null;
    if (!thread || !isOwnerThread(thread)) return;
    const since = liveCursor.get(threadId) ?? bootAt;
    const fresh = (await threads.listEvents({ threadId, limit: 20 })).filter((event) => event.createdAt > since).sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return;
    if (liveCursor.size > 2_000) liveCursor.clear();
    liveCursor.set(threadId, Math.max(...fresh.map((event) => event.createdAt)));
    for (const event of fresh) await ownerMessages.deliverEvent(event, thread);
  }

  const loadDeps = (): LoadDeps => {
    return {
      hub, threads, now: Date.now, log: (message) => bb.log.warn(message),
      projectNames: async () => new Map(((await bb.sdk.projects.list({ includePersonal: true } as never)) as unknown as Array<{ id: string; name?: string }>).map((project) => [project.id, project.name ?? project.id])),
      lpRuns: () => listAllRunRefs(db).map((row) => ({ id: row.id, projectId: row.project_id, createdAt: row.created_at })),
      ...(fragmentJudge ? { judge: fragmentJudge } : {}),
    };
  };

  return {
    hub,
    /** The one collector of the owner's messages: layers subscribe to `ownerMessages`; T1 and the daily pass (A4) are the next subscribers. */
    ownerMessages,
    threads,
    /** Gives the fragment reader a model to call (the night pass, `anamnesis load --classify`). */
    setFragmentModel(run: FragmentModel): void { fragmentJudge = fragmentJudgeVia(run); },
    liveMessages,
    runPass,
    /** The hourly tick: the pass runs once a Madrid day, after 04:00, and only while automatic learning is on. */
    async dailyTick(signal?: AbortSignal): Promise<void> {
      if (!(await dailyDue(hub, Date.now())) || (await hub.config()).extract !== true) return;
      await runPass(signal);
    },
    rpc: { anamnesis: async ({ request }: { request: AnamnesisRpcRequest }) => ({ result: request.op === "pass" ? await runPass() : await hub.dispatch(request) }) } satisfies Pick<PluginRpcHandlers<typeof anamnesisRpcMethods>, "anamnesis">,
    cli: (argv: string[]): Promise<CliResult> => runAnamnesisCli(argv, {
      hub, load: (options: LoadOptions) => loadAnamnesis(loadDeps(), options),
      /** The one-off migration (M1b): the legacy file's rows over the host's read-only `export`, then `importRows` — idempotent. */
      migrate: {
        exportTables: async () => { await refreshOwnerKey(); return innerHub.exportTables(); },
        importRows: async (tables, dryRun) => { await refreshOwnerKey(); return innerHub.store.importRows(tables, { dryRun }); },
      },
    }),
  };
}

export const anamnesisFor = (ctx: ServerCore) => {
  let mounted = cache.get(ctx);
  if (!mounted) { mounted = build(ctx); cache.set(ctx, mounted); }
  return mounted;
};

/**
 * Starts what learns by itself: the hourly tick of the daily pass and the at-message listener. Both do nothing until the owner switches
 * automatic learning on (the Anamnesis tab, or `bb lane-pilot anamnesis config --extract on`).
 */
export function mountAnamnesis(ctx: ServerCore): void {
  const { bb } = ctx;
  const mounted = anamnesisFor(ctx);
  const warn = (what: string) => (cause: unknown) => { if (!ctx.isDisposed()) bb.log.warn(`Lane Pilot anamnesis ${what} skipped: ${cause instanceof Error ? cause.message : String(cause)}`); };
  scheduleIsolated(bb, "anamnesis-daily", "17 * * * *", (signal) => mounted.dailyTick(signal).catch(warn("daily pass")), { timeoutMs: 30 * 60_000 });
  const events = (bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  if (!events || typeof events.on !== "function") return;
  try {
    events.on("thread.idle", (payload) => {
      const thread = payload && typeof payload === "object" ? Reflect.get(payload, "thread") : undefined;
      const id = thread && typeof thread === "object" ? Reflect.get(thread, "id") : undefined;
      if (typeof id === "string" && id && !ctx.isDisposed()) void mounted.liveMessages(id).catch(warn("at-message extraction"));
    });
  } catch (cause) { warn("at-message listener")(cause); }
}
