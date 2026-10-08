import type { ModelCatalog, CatalogProvider } from "@lane-pilot/models";
import { mapListedQaHosts } from "../../qa/qa-host";
import type { ServerCore } from "./core";
import { stringAt } from "./values";

const CATALOG_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 8_000;
export const CATALOG_WAIT_MS = 6_000;

export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Every provider and model the hub's machines offer, read through `bb.sdk.providers` on each connected machine and merged: a
 * provider or model lists the machines it is available on, so a picker can say «only on the Mac mini». Kept for a minute; a machine
 * that does not answer is left out instead of blocking the others.
 */
export function createModelCatalog(ctx: Pick<ServerCore, "bb" | "log">, now: () => number = Date.now) {
  const { bb } = ctx;
  let cached: { at: number; value: ModelCatalog } | null = null;
  let inflight: Promise<ModelCatalog> | null = null;

  async function read(): Promise<ModelCatalog> {
    const hosts = mapListedQaHosts(await (bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => []));
    const providers = new Map<string, CatalogProvider>();
    await Promise.all(hosts.filter((host) => host.connected).map(async (host) => {
      const listed = await within(Promise.resolve(bb.sdk.providers.list({ hostId: host.id })), CALL_TIMEOUT_MS).catch(() => []);
      await Promise.all(listed.map(async (info) => {
        const entry = providers.get(info.id) ?? {
          id: info.id, displayName: info.displayName || info.id, logoUrl: info.logoUrl ?? null, family: info.family ?? null,
          supportsServiceTier: Boolean(info.capabilities?.supportsServiceTier), serviceTiers: (info.serviceTiers ?? []).map((tier) => tier.id), hostIds: [], models: [],
        };
        providers.set(info.id, entry);
        if (!info.available) return;
        entry.hostIds.push(host.id);
        const models = await within(Promise.resolve(bb.sdk.providers.models({ providerId: info.id, hostId: host.id })), CALL_TIMEOUT_MS).then((row) => row.models, () => []);
        for (const row of models) {
          const known = entry.models.find((item) => item.id === row.id);
          if (known) { known.hostIds.push(host.id); continue; }
          entry.models.push({
            id: row.id, model: row.model, displayName: row.displayName || row.model || row.id,
            efforts: row.supportedReasoningEfforts.map((item) => item.reasoningEffort), defaultEffort: row.defaultReasoningEffort ?? null, isDefault: Boolean(row.isDefault), hostIds: [host.id],
          });
        }
      }));
    }));
    // A model some machine has comes first; a provider like OpenCode lists hundreds, and the picker is typed into by its first letters.
    for (const entry of providers.values()) entry.models.sort((a, b) => Number(b.hostIds.length > 0) - Number(a.hostIds.length > 0) || a.displayName.localeCompare(b.displayName));
    return {
      hosts: hosts.map((host) => ({ id: host.id, name: host.name, connected: host.connected })),
      providers: [...providers.values()].sort((a, b) => Number(b.hostIds.length > 0) - Number(a.hostIds.length > 0) || a.displayName.localeCompare(b.displayName)),
    };
  }

  async function get(refresh = false): Promise<ModelCatalog> {
    if (!refresh && cached && now() - cached.at < CATALOG_TTL_MS) return cached.value;
    inflight ??= read().then((value) => { cached = { at: now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  }

  /** The catalog as last read, without waiting (null before the first read); a stale or missing one is refreshed in the background. */
  function peek(): ModelCatalog | null {
    if (!cached || now() - cached.at >= CATALOG_TTL_MS) void get().catch(() => undefined);
    return cached?.value ?? null;
  }

  return { get, peek };
}
export type ModelCatalogReader = ReturnType<typeof createModelCatalog>;

/** One catalog reader per plugin instance: the Models view, the architect and the executor share one cache, so each does not ask every machine itself. */
const readers = new WeakMap<object, ModelCatalogReader>();
export function modelCatalogOf(ctx: Pick<ServerCore, "bb" | "log">): ModelCatalogReader {
  let reader = readers.get(ctx.bb);
  if (!reader) { reader = createModelCatalog(ctx); readers.set(ctx.bb, reader); }
  return reader;
}

/** The machine a PM chat's helpers run on: the host of its environment. Null when BB cannot say. */
export async function pmHostOf(bb: ServerCore["bb"], pmThreadId: string): Promise<string | null> {
  const thread = await bb.sdk.threads.get({ threadId: pmThreadId }).catch(() => null);
  const environmentId = stringAt(thread, "environmentId");
  const environment = environmentId ? await bb.sdk.environments.get({ environmentId }).catch(() => null) : null;
  return stringAt(environment, "hostId");
}
