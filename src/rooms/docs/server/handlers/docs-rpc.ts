import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { createDocsOverview, type DocsOverviewServices } from "../services/docs-overview";

/** Each folder of the project on each machine: whether it keeps docs, why, how often, and when tasks last read them. */
export function docsRpc(ctx: ServerCore, docs: DocsOverviewServices) {
  const overview = createDocsOverview(ctx, docs);
  return {
    docs_overview: async (input) => overview(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "docs_overview">;
}
