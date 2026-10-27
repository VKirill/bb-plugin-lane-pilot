import { catalogProviderOf, offeredOnHost, resolveAgentModel, type AgentModel, type AgentModelInput, type ModelCatalog } from "@lane-pilot/models";

/**
 * THE resolver right before a real spawn (Astra's review of 2026-10-27, F4): every wrapper that starts a model thread for a ROLE of the
 * table (memory, project life, docs, browser QA, errand, self-repair, rules analyzer, the council chair, the architect and every
 * generic graph helper) asks this, with the settings it already has and the catalog as last read, and spawns exactly the pair it answers.
 * It is `resolveAgentModel` (packages/models/src/agent-model.ts) with the catalog turned into the two questions that function asks:
 * is a model offered on the machine the thread starts on, and which provider lists a model. Deliberate exceptions that do not come
 * through here are listed in tests/spawn-models.test.ts.
 */
export type SpawnModelInput = Omit<AgentModelInput, "offered" | "providerOf" | "pm"> & {
  pm?: AgentModelInput["pm"];
  /** The catalog as last read (`modelCatalogOf(ctx).peek()`); null when it is cold: then every model counts as offered. */
  catalog?: ModelCatalog | null;
  /** The machine the thread starts on. */
  hostId?: string | null;
  /** A provider that just failed (a limit): nothing of it counts as offered, so the answer is the next candidate. */
  avoidProvider?: string | null;
};

export function resolveSpawnModel(input: SpawnModelInput): AgentModel {
  const { catalog, hostId, avoidProvider, pm, ...rest } = input;
  const offered = (providerId: string, model: string): boolean | null => {
    if (avoidProvider && providerId === avoidProvider) return false;
    return catalog && hostId ? offeredOnHost(catalog, providerId, model, hostId) : null;
  };
  return resolveAgentModel({ ...rest, pm: pm ?? null, ...(catalog || avoidProvider ? { offered } : {}), ...(catalog ? { providerOf: (model: string) => catalogProviderOf(catalog, model) } : {}) });
}
