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

const cache = new WeakMap<object, ReturnType<typeof build>>();

function build(ctx: ServerCore) {
  const { bb, db, host } = ctx;
  const hub: Hub = createHub({
    hostCall: async (hostId, request, timeoutMs) => (await host.call("anamnesis", { requestedHostId: hostId, request }, { hostId, timeoutMs })).response,
    listHosts: async () => mapListedQaHosts(await (bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => [])),
    kv: bb.storage.kv as never,
  });

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
    /** The one collector of the owner's messages: layers subscribe to `ownerMessages`; T1 and the daily pass (A4) are the next subscribers. */
    ownerMessages,
    threads,
    rpc: { anamnesis: async ({ request }: { request: AnamnesisRpcRequest }) => ({ result: await hub.dispatch(request) }) } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "anamnesis">,
    cli: (argv: string[]): Promise<CliResult> => runAnamnesisCli(argv, { hub, load: (options: LoadOptions) => loadAnamnesis(loadDeps(), options) }),
  };
}

export const anamnesisFor = (ctx: ServerCore) => {
  let mounted = cache.get(ctx);
  if (!mounted) { mounted = build(ctx); cache.set(ctx, mounted); }
  return mounted;
};
