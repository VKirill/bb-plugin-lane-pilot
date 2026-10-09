/**
 * Who serves System One: TypeSafe itself or OpenLux, a reseller with the same request and answer bodies at ~60% of the price.
 * One table gives url, model and the Env Catalog record per provider; the server, the host workers and the client read it, so
 * a host is told only the provider id (and the key), never a URL to send the key to. No imports: the host bundle takes this file.
 *
 * OpenLux: the model must be pinned (`jev-latest` is a 403 there); `:stable` picks the route with the best success rate. A call
 * takes ~0.6 s longer than on TypeSafe (0.5-0.9 s against 0.28 s), size of the state barely matters (60k characters: 0.6 s), so
 * `timeoutPadMs` is a fixed headroom added to every timeout instead of a scale.
 */
export type JevProviderId = "openlux" | "typesafe";
export type JevProvider = { id: JevProviderId; url: string; model: string; keyName: string; timeoutPadMs: number };

export const JEV_PROVIDERS: Record<JevProviderId, JevProvider> = {
  typesafe: { id: "typesafe", url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", keyName: "TYPESAFE_API_KEY", timeoutPadMs: 0 },
  openlux: { id: "openlux", url: "https://api.openlux.ai/v1/systemone", model: "jev-1.13.0:stable", keyName: "OPENLUX_API_KEY", timeoutPadMs: 1_500 },
};
export const DEFAULT_JEV_PROVIDER: JevProviderId = "openlux";
export const JEV_PROVIDER_IDS = Object.keys(JEV_PROVIDERS) as JevProviderId[];

/** The provider a setting value names; the default when it is absent or unknown. */
export function resolveJevProvider(value: unknown): JevProvider {
  return typeof value === "string" && Object.hasOwn(JEV_PROVIDERS, value) ? JEV_PROVIDERS[value as JevProviderId] : JEV_PROVIDERS[DEFAULT_JEV_PROVIDER];
}

/** A provider id from a host call; a missing or unknown one is TypeSafe, the behaviour before providers. */
export function jevProviderOfHostCall(value: unknown): JevProvider {
  return typeof value === "string" && Object.hasOwn(JEV_PROVIDERS, value) ? JEV_PROVIDERS[value as JevProviderId] : JEV_PROVIDERS.typesafe;
}
