import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { JEV_PROVIDERS, JEV_PROVIDER_IDS, createJevClient, resolveJevProvider } from "@lane-pilot/jev";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { rpcContract } from "../../../contracts";
import { loadProjectSettings } from "../../../storage";
import type { ServerCore } from "../../../core/server";

/** The one question of the test request: a statement Jev answers with a probability, nothing about the plugin in it. */
const TEST_REQUEST = { state: { statement: "Two plus two equals four." }, questions: { check: { type: "noul" as const, instructions: "Is the statement in the state true?" } } };
const TEST_TIMEOUT_MS = 15_000;

/**
 * The Jev block of the global settings page: which provider is chosen and has a key (names and yes/no, a key is never read for the
 * answer and never returned), saving a key into Env Catalog, and one real request through the chosen provider.
 */
export function jevProviderRpc(ctx: ServerCore) {
  const chosen = () => resolveJevProvider(loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID)["jev.provider"]);

  async function status() {
    const wanted = chosen();
    const names = await ctx.secrets.list({ fresh: true });
    const providers = JEV_PROVIDER_IDS.map((id) => ({ id, keyName: JEV_PROVIDERS[id].keyName, model: JEV_PROVIDERS[id].model, hasKey: Boolean(names?.some((entry) => entry.name === JEV_PROVIDERS[id].keyName)) }));
    const has = (id: string) => providers.find((item) => item.id === id)!.hasKey;
    // The same rule as jevEndpoint in core.ts: the chosen provider when it has a key, else TypeSafe, else nobody.
    const effective = has(wanted.id) ? wanted.id : has("typesafe") ? "typesafe" as const : null;
    return { chosen: wanted.id, effective, catalog: names ? "ok" as const : "unavailable" as const, providers };
  }

  return {
    jev_provider_status: () => status(),
    jev_provider_save_key: async ({ provider, key }) => {
      const value = key.trim();
      if (!value || /\s/.test(value)) throw new Error("A key is one line without spaces.");
      const target = JEV_PROVIDERS[provider];
      await ctx.secrets.save(target.keyName, value, { service: provider === "openlux" ? "OpenLux" : "TypeSafe", description: "Jev API key (Lane Pilot settings)" });
      ctx.forgetCatalogKey(target.keyName);
      ctx.log(`jev key: ${target.keyName} saved to Env Catalog from the settings page`);
      return await status();
    },
    jev_provider_test: async () => {
      const provider = chosen();
      ctx.forgetCatalogKey(provider.keyName);
      const apiKey = await ctx.catalogKey(provider.keyName);
      if (!apiKey) return { ok: false, provider: provider.id, model: null, latencyMs: 0, error: `no ${provider.keyName} in Env Catalog` };
      const result = await createJevClient({ endpoint: async () => ({ provider, apiKey }) }).call(TEST_REQUEST, { timeoutMs: TEST_TIMEOUT_MS });
      return result.ok
        ? { ok: true, provider: provider.id, model: result.model, latencyMs: Math.round(result.latencyMs), error: null }
        : { ok: false, provider: provider.id, model: null, latencyMs: Math.round(result.latencyMs), error: result.error };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "jev_provider_status" | "jev_provider_save_key" | "jev_provider_test">;
}
