import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CriticCatalog } from "../../models/critic-pair";

/** The host catalog through the BB SDK; the provider list is read once. */
export function sdkCriticCatalog(bb: Pick<BbPluginApi, "sdk">, hostId: string): CriticCatalog {
  let providers: Promise<Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>> | null = null;
  return {
    async provider(providerId) {
      providers ??= Promise.resolve(bb.sdk.providers.list({ hostId }));
      const row = (await providers).find((item) => item.id === providerId);
      return row ? { id: row.id, available: Boolean(row.available), supportsServiceTier: Boolean(row.capabilities?.supportsServiceTier),
        serviceTiers: (row.serviceTiers ?? []).map((item) => item.id) } : null;
    },
    async models(providerId) {
      const listed = await bb.sdk.providers.models({ providerId, hostId });
      return listed.models.map((row) => ({ id: row.id, model: row.model, efforts: row.supportedReasoningEfforts.map((item) => item.reasoningEffort) }));
    },
  };
}
