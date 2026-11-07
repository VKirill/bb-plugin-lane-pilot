import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { AgentModel, AgentModelInput, ModelCatalog } from "@lane-pilot/models";
import type { LanePilotDatabase } from "../../storage";
import { clearSpawnMarker, fullAccessSpawn, graphStepMetadata, keyedSpawnSupported, modelCatalogOf, readProviderFolderBlock, registerObservedTool, requirePmRun, resolveSpawnModel, scheduleIsolated, spawnTextId, spawnUsageOf, warmSpawnUsage } from "../../platform/server";

/**
 * The core pieces self-repair is handed by the composition root, so the room imports nothing from core. The shapes are
 * the ones the core functions already have (platform/server/spawn-model.ts, thread-keys.ts, pm-spawn.ts, schedules.ts,
 * context.ts, tool-result.ts); they are restated here because naming them through `core` would keep the room edge.
 */

export type ProviderFolderBlock = { reason: string; at: number };
export type SpawnUsage = {
  peek(query: { providerId: string; model: string; hostId: string | null; settings: Record<string, unknown> }): { percent: number; window: string } | null;
  warm(query: { providerIds: readonly string[]; hostId: string | null }): Promise<void>;
  /** Whether a Lane Pilot thread is working on the ZCode app now (it takes one task at a time); absent: not known, taken as free. */
  zcodeBusy?(): boolean;
};
export type SpawnUsageUse = SpawnUsage & { log?: ((line: string) => void) | undefined };
export type SpawnModelInput = Omit<AgentModelInput, "offered" | "providerOf" | "pm"> & {
  /** The folder the thread starts in: a provider that cannot work there is not offered. */
  envPath?: string | null;
  pm?: AgentModelInput["pm"];
  /** The catalog as last read; null when it is cold: then every model counts as offered. */
  catalog?: ModelCatalog | null;
  /** The machine the thread starts on. */
  hostId?: string | null;
  /** A provider that just failed (a limit): nothing of it counts as offered, so the answer is the next candidate. */
  avoidProvider?: string | null;
  /** Provider limits: a nearly spent provider's pick moves to the other family. */
  usage?: SpawnUsageUse | undefined;
  /** An observed start failure of the pick's provider in this folder on this machine, else none. */
  folderBlock?: ProviderFolderBlock | null;
};
export type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
type ScheduleWork = (signal?: AbortSignal) => unknown;
export type ObservedTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  instructions?: string;
  parameters: S;
  execute: (params: z.output<S>, context: { threadId: string; projectId: string; signal: AbortSignal }) => unknown;
  /** Starts work (a writer, an errand, a specialist, a graph): refused in a turn that another chat's message started. */
  startsWork?: boolean;
};

export type SelfRepairDeps = {
  clearSpawnMarker: (bb: BbPluginApi, metadata: Record<string, unknown>) => Promise<void>;
  fullAccessSpawn: (bb: BbPluginApi, args: SpawnArgs) => Promise<unknown>;
  graphStepMetadata: (step: { runId: string; stepKey?: string | undefined; nodeId?: string | undefined } | null | undefined) => Record<string, string>;
  keyedSpawnSupported: (bb: BbPluginApi) => boolean;
  modelCatalogOf: (ctx: { bb: BbPluginApi; log: (message: string) => void }) => { peek(): ModelCatalog | null };
  readProviderFolderBlock: (kv: { get(key: string): Promise<unknown> }, hostId: string | null, providerId: string, ttlMs?: number) => Promise<ProviderFolderBlock | null>;
  registerObservedTool: <S extends z.ZodType>(agents: Pick<BbPluginApi["agents"], "registerTool">, tool: ObservedTool<S>) => void;
  requirePmRun: (db: LanePilotDatabase, input: { runId: string; threadId: string; projectId: string }) => { id: string; project_id: string };
  resolveSpawnModel: (input: SpawnModelInput) => AgentModel;
  scheduleIsolated: (bb: BbPluginApi, name: string, cron: string, work: ScheduleWork, options: { timeoutMs: number; fallback?: ScheduleWork }) => void;
  spawnTextId: (text: string) => string;
  spawnUsageOf: (owner: { bb: object; log?: ((line: string) => void) | undefined }) => SpawnUsageUse | undefined;
  warmSpawnUsage: (usage: SpawnUsageUse | undefined, hostId: string | null) => Promise<void>;
};

/** What the watcher and its graph need: the spawn/model helpers plus the isolated scheduler its mount uses. */
export type RepairDeps = Pick<SelfRepairDeps, "clearSpawnMarker" | "fullAccessSpawn" | "graphStepMetadata" | "keyedSpawnSupported" | "modelCatalogOf" | "resolveSpawnModel" | "scheduleIsolated">;
/** What the rules scan and ask graphs need. */
export type RuleScanDeps = Pick<SelfRepairDeps, "fullAccessSpawn" | "modelCatalogOf" | "readProviderFolderBlock" | "resolveSpawnModel" | "scheduleIsolated" | "spawnTextId" | "spawnUsageOf" | "warmSpawnUsage">;
/** What the insights tools and their sweep need. */
export type InsightsDeps = Pick<SelfRepairDeps, "registerObservedTool" | "requirePmRun" | "scheduleIsolated">;

/** The platform helpers this room is handed, assembled once; the composition root and the mount sites call this. */
export function selfRepairDeps(): SelfRepairDeps {
  return {
    clearSpawnMarker, fullAccessSpawn, graphStepMetadata, keyedSpawnSupported, modelCatalogOf,
    readProviderFolderBlock, registerObservedTool, requirePmRun, resolveSpawnModel, scheduleIsolated,
    spawnTextId, spawnUsageOf, warmSpawnUsage,
  };
}
