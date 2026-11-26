import type { Services } from "../../../services";
import type { PluginCliContext } from "@get-bb/plugin-sdk";
export { OWNER_ITEM_SWEEPS } from "../../../lead/server";
import type { ServerCore } from "./cli-imports";

/** What the split command handlers share from `registerCli`: the server context, the services bag and the parsed argv. */
export interface CliRunDeps {
  ctx: ServerCore;
  services: Services;
  command: string | undefined;
  args: string[];
  invocation: PluginCliContext;
  commands: Array<{ name: string; summary: string; usage: string }>;
  migrations: readonly string[];
}
