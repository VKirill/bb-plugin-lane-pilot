import type { BbPluginApi, ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import type { NativeSelection } from "../../../contracts";
import { nativeAgentTypeKey, nativeEnvGenerationKey, nativeEnvKey } from "../../../contracts";
import { sha256Hex } from "@lane-pilot/kit";
import {
  NATIVE_HELPER_ENV_GENERATION,
  NATIVE_STANDALONE_ENV_GENERATION,
  type NativeEnvBinding,
  type NativeEnvPlacement,
} from "../../models/native-env-cache";

export async function rememberNativeEnv(
  bb: BbPluginApi,
  threadId: string,
  selected: NativeSelection,
  prepared: { env: ExperimentalPluginProviderEnvEntry[]; agentId: string },
  placement: NativeEnvPlacement,
): Promise<void> {
  await bb.storage.kv.set(nativeEnvKey(threadId), prepared.env);
  await bb.storage.kv.set(nativeAgentTypeKey(threadId), prepared.agentId);
  await bb.storage.kv.set(
    nativeEnvGenerationKey(threadId),
    {
      generation: selected.parentRunId ? NATIVE_HELPER_ENV_GENERATION : NATIVE_STANDALONE_ENV_GENERATION,
      selectionToken: selected.token,
      agentId: prepared.agentId,
      helper: Boolean(selected.parentRunId),
      envHash: sha256Hex(JSON.stringify(prepared.env)),
      ...placement,
    } satisfies NativeEnvBinding,
  );
}
