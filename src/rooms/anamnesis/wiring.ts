import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../contracts";
import { mapListedQaHosts } from "../qa/qa-host";
import type { ServerCore } from "../core/server/core";
import type { AnamnesisRpcRequest } from "./contract";
import { runAnamnesisCli, type CliResult } from "./cli";
import { createHub, type Hub } from "./hub";
import { jev } from "@lane-pilot/jev";
import { fragmentJudgment, matchJudgment } from "./judgment";
import { loadAnamnesis, type LoadDeps, type LoadOptions } from "./load";
import { createOwnerMessageHub, isOwnerThread, sdkThreadsPort, type ThreadLike } from "./owner-messages";
import { createExtractConsumer, type ExtractDeps } from "./extract";
import { dailyDue, dailyPass, markDailyDone, type DailyDeps } from "./daily";
import { scheduleIsolated } from "../core/server/schedules";

const cache = new WeakMap<object, ReturnType<typeof build>>();

function build(ctx: ServerCore) {
  const { bb, db, host } = ctx;
  const hub: Hub = createHub({
    hostCall: async (hostId, request, timeoutMs) => (await host.call("anamnesis", { requestedHostId: hostId, request }, { hostId, timeoutMs })).response,
    listHosts: async () => mapListedQaHosts(await (bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => [])),
    kv: bb.storage.kv as never,
  });

  const ownerMessages = createOwnerMessageHub(), threads = sdkThreadsPort(bb as never);
  /** Jev's two judgments over masked texts; null for a text it could not judge. */
  const judgeFragments = async (texts: string[], signal?: AbortSignal) => {
    const verdicts = await jev()!.judgeMany(fragmentJudgment, texts.map((text) => ({ text })), { subject: "anamnesis", signal });
    return verdicts.map((verdict) => (verdict.by === "jev" ? verdict.decision : null));
  };
  const judgeMatches = async (pairs: Array<{ fragment: string; known: string }>, signal?: AbortSignal) => {
    const verdicts = await jev()!.judgeMany(matchJudgment, pairs, { subject: "anamnesis", signal });
    return verdicts.map((verdict) => (verdict.by === "jev" ? verdict.decision : null));
  };
  /** Read when used: Jev is installed after this module is built. Absent while Jev is off, which nothing here works around. */
  const extractDeps: ExtractDeps = {
    hub, now: Date.now,
    get judge() { const instance = jev(); return instance && instance.enabled() ? judgeFragments : undefined; },
    get match() { const instance = jev(); return instance && instance.enabled() ? judgeMatches : undefined; },
  };
  const consumer = createExtractConsumer(extractDeps);
  ownerMessages.subscribe(consumer);

  const dailyDeps = (): DailyDeps => ({
    hub, threads, owner: ownerMessages, consumer, now: Date.now,
    projectNames: async () => new Map(((await bb.sdk.projects.list({ includePersonal: true } as never)) as unknown as Array<{ id: string; name?: string }>).map((project) => [project.id, project.name ?? project.id])),
    lpRuns: () => (db.prepare("SELECT id, project_id, created_at FROM lane_pilot_run").all() as Array<{ id: string; project_id: string; created_at: number }>)
      .map((row) => ({ id: row.id, projectId: row.project_id, createdAt: row.created_at })),
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
    const instance = jev();
    return {
      hub, threads, now: Date.now,
      projectNames: async () => new Map(((await bb.sdk.projects.list({ includePersonal: true } as never)) as unknown as Array<{ id: string; name?: string }>).map((project) => [project.id, project.name ?? project.id])),
      lpRuns: () => (db.prepare("SELECT id, project_id, created_at FROM lane_pilot_run").all() as Array<{ id: string; project_id: string; created_at: number }>)
        .map((row) => ({ id: row.id, projectId: row.project_id, createdAt: row.created_at })),
      ...(instance && instance.enabled() ? { judge: judgeFragments } : {}),
    };
  };

  return {
    hub,
    /** The one collector of the owner's messages: layers subscribe to `ownerMessages`; T1 and the daily pass (A4) are the next subscribers. */
    ownerMessages,
    threads,
    liveMessages,
    runPass,
    /** The hourly tick: the pass runs once a Madrid day, after 04:00, and only while automatic learning is on. */
    async dailyTick(signal?: AbortSignal): Promise<void> {
      if (!(await dailyDue(hub, Date.now())) || (await hub.config()).extract !== true) return;
      await runPass(signal);
    },
    rpc: { anamnesis: async ({ request }: { request: AnamnesisRpcRequest }) => ({ result: request.op === "pass" ? await runPass() : await hub.dispatch(request) }) } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "anamnesis">,
    cli: (argv: string[]): Promise<CliResult> => runAnamnesisCli(argv, { hub, load: (options: LoadOptions) => loadAnamnesis(loadDeps(), options) }),
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
