import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../contracts";
import { mapListedQaHosts } from "../qa-host";
import type { ServerCore } from "../server/core";
import type { AnamnesisRpcRequest } from "./contract";
import { runAnamnesisCli, type CliResult } from "./cli";
import { createHub, type Hub } from "./hub";
import { jev } from "../jev/runtime";
import { fragmentJudgment } from "./judgment";
import { loadAnamnesis, type LoadDeps, type LoadOptions } from "./load";
import { createOwnerMessageHub, sdkThreadsPort } from "./owner-messages";

/** What Lane Pilot's own helper, writer and stage threads are: they never read the owner's records. */
export function isAgentChild(thread: { parentThreadId?: string | null; originPluginId?: string | null } | null): boolean {
  return !thread || !!thread.parentThreadId || thread.originPluginId === "lane-pilot";
}

const cache = new WeakMap<object, ReturnType<typeof build>>();

function build(ctx: ServerCore) {
  const { bb, db, host } = ctx;
  const hub: Hub = createHub({
    hostCall: async (hostId, request, timeoutMs) => (await host.call("anamnesis", { requestedHostId: hostId, request }, { hostId, timeoutMs })).response,
    listHosts: async () => mapListedQaHosts(await (bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => [])),
    kv: bb.storage.kv as never,
  });

  /**
   * The command runs in the caller's shell. Without a thread id it is the owner at a terminal. A thread must be an ordinary chat or a
   * PM of a Lane Pilot run; a writer, helper or stage thread (a child, or made by this plugin) is refused, and so is a thread that
   * cannot be looked up (fail closed).
   */
  async function deny(threadId: string | undefined): Promise<string | null> {
    if (!threadId) return null;
    if (db.prepare("SELECT 1 AS x FROM lane_pilot_run WHERE pm_thread_id=? LIMIT 1").get(threadId)) return null;
    const thread = await ctx.getThreadBounded(threadId) as { parentThreadId?: string | null; originPluginId?: string | null } | null;
    return isAgentChild(thread) ? "The owner's anamnesis is not available to writers, helpers or stage threads." : null;
  }

  const ownerMessages = createOwnerMessageHub(), threads = sdkThreadsPort(bb as never);
  const loadDeps = (): LoadDeps => {
    const instance = jev();
    return {
      hub, threads, now: Date.now,
      projectNames: async () => new Map(((await bb.sdk.projects.list({ includePersonal: true } as never)) as unknown as Array<{ id: string; name?: string }>).map((project) => [project.id, project.name ?? project.id])),
      lpRuns: () => (db.prepare("SELECT id, project_id, created_at FROM lane_pilot_run").all() as Array<{ id: string; project_id: string; created_at: number }>)
        .map((row) => ({ id: row.id, projectId: row.project_id, createdAt: row.created_at })),
      ...(instance && instance.enabled() ? { judge: async (texts: string[], signal?: AbortSignal) => {
        const verdicts = await instance.judgeMany(fragmentJudgment, texts.map((text) => ({ text })), { subject: "anamnesis", signal });
        return verdicts.map((verdict) => (verdict.by === "jev" ? verdict.decision : null));
      } } : {}),
    };
  };

  return {
    hub,
    deny,
    /** The one collector of the owner's messages: layers subscribe to `ownerMessages`; T1 and the daily pass (A4) are the next subscribers. */
    ownerMessages,
    threads,
    rpc: { anamnesis: async ({ request }: { request: AnamnesisRpcRequest }) => ({ result: await hub.dispatch(request) }) } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "anamnesis">,
    cli: (argv: string[], cliCtx?: { threadId?: string }): Promise<CliResult> => runAnamnesisCli(argv, { hub, deny, threadId: cliCtx?.threadId, load: (options: LoadOptions) => loadAnamnesis(loadDeps(), options) }),
  };
}

export const anamnesisFor = (ctx: ServerCore) => {
  let mounted = cache.get(ctx);
  if (!mounted) { mounted = build(ctx); cache.set(ctx, mounted); }
  return mounted;
};
