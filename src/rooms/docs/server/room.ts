import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { docsSettings } from "../settings";
import { docsRpc } from "./handlers/docs-rpc";
import type { DocsOverviewServices } from "./services/docs-overview";

export const room: Room<DocsOverviewServices> = {
  name: "docs",
  settings: docsSettings,
  rpc: (ctx: ServerCore, services: DocsOverviewServices) => docsRpc(ctx, services),
};
