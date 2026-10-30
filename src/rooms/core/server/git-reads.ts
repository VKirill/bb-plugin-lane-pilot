import { z } from "zod";
import type { JsonValue } from "@get-bb/plugin-sdk";

/**
 * Git reads through the bundled Git plugin (`bb--git`), the replacement for the retired
 * `environments.status`/`diff`/`diffPatch` SDK calls. `callRpc` is absent on an old BB;
 * callers then keep the `environments.*` call as their fallback.
 */
export type PluginCallRpc = (args: { pluginId: string; method: string; input?: JsonValue; outputSchema: z.ZodType<unknown>; signal?: AbortSignal }) => Promise<unknown>;

export const GIT_PLUGIN_ID = "bb--git";

export function gitCallRpc(bb: unknown): PluginCallRpc | undefined {
  const callRpc = (bb as { sdk?: { plugins?: { callRpc?: PluginCallRpc } } })?.sdk?.plugins?.callRpc;
  return typeof callRpc === "function" ? (args) => callRpc(args) : undefined;
}

export const gitPatchEntrySchema = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() }).passthrough();
const gitUnavailable = z.object({ outcome: z.enum(["not_applicable", "unavailable"]) }).passthrough();
export const gitFilesReplySchema = z.union([
  z.object({
    outcome: z.literal("available"),
    files: z.array(z.object({ path: z.string(), revision: z.string() }).passthrough()),
    initialPatches: z.array(gitPatchEntrySchema),
  }).passthrough(),
  gitUnavailable,
]);
export const gitPatchesReplySchema = z.record(
  z.string(),
  z.union([z.object({ outcome: z.literal("available"), patch: gitPatchEntrySchema }).passthrough(), gitUnavailable]),
);

/** The key `bb--git`'s `patches` method wants: the same tuple `gitPatchKey` in the plugin's contract serializes. */
export function gitPatchKey(environmentId: string, target: unknown, ignoreWhitespace: boolean, path: string, revision: string): string {
  return JSON.stringify([environmentId, target, ignoreWhitespace, path, revision]);
}
