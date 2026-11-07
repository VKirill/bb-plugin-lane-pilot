import { clearSpawnMarker, keyedSpawnSupported, spawnTextId } from "./thread-keys";
import { fullAccessSpawn, graphStepMetadata } from "./pm-spawn";
import { modelCatalogOf } from "./model-catalog-reader";
import { readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "./spawn-model";
import { scheduleIsolated } from "./schedules";
import { requirePmRun } from "./context";
import { registerObservedTool } from "./tool-result";
import type { SelfRepairDeps } from "../../self-repair/server";

/**
 * The core functions the self-repair room is handed so it imports nothing from core (the untangle boundary): the
 * composition root and the mount sites pass this bag; the room declares the shapes it needs in server/deps.ts.
 */
export function selfRepairDeps(): SelfRepairDeps {
  return {
    clearSpawnMarker, fullAccessSpawn, graphStepMetadata, keyedSpawnSupported, modelCatalogOf,
    readProviderFolderBlock, registerObservedTool, requirePmRun, resolveSpawnModel, scheduleIsolated,
    spawnTextId, spawnUsageOf, warmSpawnUsage,
  };
}
