import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import type { NativeSelection } from "../../contracts";
import { sha256Hex } from "@lane-pilot/kit";

export const NATIVE_HELPER_ENV_GENERATION = "native-helper-settings-v1";
export const NATIVE_STANDALONE_ENV_GENERATION = "native-standalone-settings-v1";

export type NativeEnvPlacement = { hostId: string; cwd: string | null; environmentId: string | null };
export type NativeEnvBinding = NativeEnvPlacement & {
  generation: string;
  selectionToken: string;
  agentId: string;
  helper: boolean;
  envHash: string;
};

export function nativeEnvBinding(raw: unknown): NativeEnvBinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.generation !== "string" || typeof value.selectionToken !== "string" || typeof value.agentId !== "string" || typeof value.helper !== "boolean" || typeof value.envHash !== "string" || typeof value.hostId !== "string" || (value.cwd !== null && typeof value.cwd !== "string") || (value.environmentId !== null && typeof value.environmentId !== "string")) return null;
  return value as unknown as NativeEnvBinding;
}

export function nativeCacheIsCurrent(
  selected: NativeSelection,
  cached: ExperimentalPluginProviderEnvEntry[] | undefined,
  generation: unknown,
  placement: NativeEnvPlacement,
  placementKnown = true,
): boolean {
  if (!cached?.length) return false;
  const binding = nativeEnvBinding(generation);
  // Preserve the old standalone cache fallback. Helpers never use an unqualified cache because it may be a v8 launcher.
  if (!binding) return !selected.parentRunId;
  if (!nativeCacheIdentityMatches(selected, cached, binding)) return false;
  if (!placementKnown && !selected.parentRunId) return true;
  return binding.hostId === placement.hostId
    && binding.cwd === placement.cwd
    && binding.environmentId === placement.environmentId;
}

export function nativeCacheIdentityMatches(
  selected: NativeSelection,
  cached: ExperimentalPluginProviderEnvEntry[] | undefined,
  binding: NativeEnvBinding | null,
): boolean {
  if (!cached?.length || !binding) return false;
  return binding.generation === (selected.parentRunId ? NATIVE_HELPER_ENV_GENERATION : NATIVE_STANDALONE_ENV_GENERATION)
    && binding.selectionToken === selected.token
    && binding.agentId === selected.agentId
    && binding.helper === Boolean(selected.parentRunId)
    && binding.envHash === sha256Hex(JSON.stringify(cached));
}
