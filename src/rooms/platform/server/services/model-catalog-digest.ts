import { LP_EVENTS } from "@lane-pilot/contracts";
import { canonicalJson, sha256Hex } from "@lane-pilot/kit";
import { MODEL_PRICES, ROLE_MODEL_KEY_PREFIX, type ModelCatalog, type ModelPrice } from "@lane-pilot/models";
import type { ServerCore } from "../../../contracts/server";
import { listProjectsWithGlobalSettings, listSettingRows, onSettingChanged, type LanePilotDatabase } from "../../../storage";
import { modelCatalogOf, onModelCatalogRefreshed } from "./model-catalog-reader";

export const MODEL_CATALOG_DIGEST_KV_KEY = "lp.models.catalog_digest";

export type CatalogDigestOptions = {
  prices?: Record<string, ModelPrice>;
  roleModels?: Record<string, unknown>;
  db?: LanePilotDatabase;
};

export type CatalogKvStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export type CatalogDigestEmit = (
  name: string,
  payload?: Record<string, unknown>,
  options?: { id?: string; key?: string; projectId?: string },
) => Promise<unknown>;

export type CheckCatalogDigestInput = {
  catalog: ModelCatalog;
  kv: CatalogKvStore;
  db?: LanePilotDatabase;
  prices?: Record<string, ModelPrice>;
  roleModels?: Record<string, unknown>;
  emitEvent?: CatalogDigestEmit;
  log?: { debug?: (m: string) => void; info?: (m: string) => void; warn?: (m: string) => void };
};

export type CheckCatalogDigestResult = {
  changed: boolean;
  seeded: boolean;
  prevSha: string | null;
  nextSha: string;
};

/** Collects all persisted `role_model.*` settings across global and project scopes for digest hashing. */
export function readRoleModelSettings(db: LanePilotDatabase): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const projectId of listProjectsWithGlobalSettings(db)) {
    for (const row of listSettingRows(db, projectId)) {
      if (row.key.startsWith(ROLE_MODEL_KEY_PREFIX)) {
        out[`${projectId}:${row.key}`] = row.value;
      }
    }
  }
  return out;
}

/**
 * Computes the deterministic SHA-256 digest of the sorted `(host, provider, model, effort)` matrix,
 * `MODEL_PRICES`, and `role_model.*` settings.
 */
export function catalogDigest(read: ModelCatalog, options: CatalogDigestOptions = {}): string {
  const tuples = new Set<string>();
  const matrix: Array<[string, string, string, string]> = [];
  for (const provider of read.providers ?? []) {
    for (const model of provider.models ?? []) {
      const hosts = model.hostIds.length > 0 ? model.hostIds : [""];
      const efforts = model.efforts.length > 0 ? model.efforts : [model.defaultEffort ?? ""];
      for (const host of hosts) {
        for (const effort of efforts) {
          const key = `${host}\0${provider.id}\0${model.id}\0${effort}`;
          if (tuples.has(key)) continue;
          tuples.add(key);
          matrix.push([host, provider.id, model.id, effort]);
        }
      }
    }
  }
  matrix.sort((a, b) =>
    a[0].localeCompare(b[0])
    || a[1].localeCompare(b[1])
    || a[2].localeCompare(b[2])
    || a[3].localeCompare(b[3]),
  );

  const pricesSource = options.prices ?? MODEL_PRICES;
  const prices = Object.keys(pricesSource)
    .sort()
    .map((key) => [key, pricesSource[key]!] as const);

  const rawRoleModels = options.roleModels ?? (options.db ? readRoleModelSettings(options.db) : {});
  const roleModels = Object.keys(rawRoleModels)
    .filter((key) => key.includes(ROLE_MODEL_KEY_PREFIX))
    .sort()
    .map((key) => [key, rawRoleModels[key]] as const);

  return sha256Hex(canonicalJson({ matrix, prices, roleModels }));
}

/**
 * Compares the current catalog digest against `bb.storage.kv` key `lp.models.catalog_digest`.
 * Seeds the key on first run without emitting; emits `LP_EVENTS.MODEL_CATALOG_CHANGED` on subsequent changes.
 */
export async function checkModelCatalogDigest(input: CheckCatalogDigestInput): Promise<CheckCatalogDigestResult> {
  const nextSha = catalogDigest(input.catalog, {
    ...(input.prices ? { prices: input.prices } : {}),
    ...(input.roleModels ? { roleModels: input.roleModels } : {}),
    ...(input.db ? { db: input.db } : {}),
  });
  const stored = await input.kv.get(MODEL_CATALOG_DIGEST_KV_KEY);
  const prevSha = typeof stored === "string" && stored.trim() ? stored.trim() : null;

  if (prevSha === nextSha) {
    return { changed: false, seeded: false, prevSha, nextSha };
  }

  await input.kv.set(MODEL_CATALOG_DIGEST_KV_KEY, nextSha);
  if (prevSha === null) {
    input.log?.debug?.(`model catalog digest seeded sha=${nextSha.slice(0, 12)}`);
    return { changed: false, seeded: true, prevSha: null, nextSha };
  }

  input.log?.info?.(`model catalog changed prev=${prevSha.slice(0, 12)} next=${nextSha.slice(0, 12)}`);
  await input.emitEvent?.(
    LP_EVENTS.MODEL_CATALOG_CHANGED,
    { prevSha, nextSha },
    { id: `catalog:${nextSha}`, key: nextSha },
  );
  return { changed: true, seeded: false, prevSha, nextSha };
}

/**
 * Wires catalog digest detection to `createModelCatalog().read()` refreshes, `role_model.*` setting writes,
 * and an explicit `sync()` hook for startup recovery.
 */
export function mountModelCatalogDigest(
  ctx: Pick<ServerCore, "bb" | "db" | "log">,
  deps: { emitEvent?: CatalogDigestEmit; kv?: CatalogKvStore } = {},
) {
  const kv = deps.kv ?? (ctx.bb.storage.kv as CatalogKvStore);
  const reader = modelCatalogOf(ctx);

  let latestCheck: Promise<CheckCatalogDigestResult> | null = null;

  const checkCatalog = (catalog: ModelCatalog) => {
    const run = checkModelCatalogDigest({
      catalog,
      kv,
      db: ctx.db,
      ...(deps.emitEvent ? { emitEvent: deps.emitEvent } : {}),
      log: ctx.bb.log,
    });
    latestCheck = run;
    return run;
  };

  const unsubRefresh = onModelCatalogRefreshed(ctx.bb, async (catalog) => {
    await checkCatalog(catalog).catch((cause: unknown) => {
      ctx.bb.log?.warn?.(`model catalog digest check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });

  const unsubSetting = onSettingChanged(ctx.db, (_projectId, keys) => {
    if (!keys.some((key) => key.startsWith(ROLE_MODEL_KEY_PREFIX))) return;
    const peeked = reader.peek();
    if (peeked) {
      void checkCatalog(peeked).catch((cause: unknown) => {
        ctx.bb.log?.warn?.(`model catalog digest check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    } else {
      void reader.get().catch(() => undefined);
    }
  });

  const dispose = () => {
    unsubRefresh();
    unsubSetting();
  };
  ctx.bb.onDispose?.(dispose);

  return {
    sync: async (): Promise<CheckCatalogDigestResult | null> => {
      try {
        latestCheck = null;
        const catalog = await reader.get(true);
        return await (latestCheck ?? checkCatalog(catalog));
      } catch (cause) {
        ctx.bb.log?.warn?.(`model catalog digest startup sync failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    },
    checkCatalog,
    dispose,
  };
}
