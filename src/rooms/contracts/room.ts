import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import type { SettingDefinition } from "@lane-pilot/settings-catalog";
import type { ServerCore } from "./server-core";

/** What a verb of `bb lane-pilot` is handed: the server, the rooms' services, the words after the verb and who called. */
export interface RoomCliCall<S> {
  ctx: ServerCore;
  services: S;
  args: string[];
  invocation: PluginCliContext | undefined;
}

/** One `bb lane-pilot <name>`: declared once, here; the help, `explain` and the dispatcher all read it. */
export interface RoomCliVerb<S = unknown> {
  name: string;
  summary: string;
  usage: string;
  /** The help prints the whole `usage` text (several lines) instead of its first line plus the summary. */
  fullHelp?: true;
  /** Undefined: the words did not fit this verb; the help answers, as for an unknown verb. */
  run(call: RoomCliCall<S>): Promise<PluginCliResult | undefined> | PluginCliResult | undefined;
}

/**
 * What a room offers the plugin; src/rooms/registry.ts lists the rooms. Deleting a room is deleting its folder and its line there.
 * `S` is the slice of the services bag the room reads: a hook typed with fewer fields takes the whole bag.
 */
export interface Room<S = unknown> {
  name: string;
  /** The room's slice of src/rooms/migrations.ts, in the order it is spread there (the list is index-locked, so the room cannot move it). */
  migrations?: readonly string[];
  /** Typed settings owned by this room, composed into the plugin settings registry. */
  settings?: readonly SettingDefinition[];
  /** Optional bilingual i18n copy contributed by this room. */
  i18n?: { readonly en?: Readonly<Record<string, string>>; readonly ru?: Readonly<Record<string, string>> };
  /** RPC handlers by contract key; a key is owned by one room. */
  rpc?: (ctx: ServerCore, services: S) => Record<string, unknown>;
  cli?: readonly RoomCliVerb<S>[];
  /** Registers PM tools as members of the tool families, at the fold in registerTools. */
  tools?: (ctx: ServerCore, services: S) => void;
  /** Schedules, listeners and graph steps, mounted once the services bag is complete. */
  startup?: (ctx: ServerCore, services: S) => void | Promise<void>;
}
