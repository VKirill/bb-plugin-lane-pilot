/**
 * The capability table (SMA atlas D2-7: «Capability table», «Short adapter probe», «Probe receipt», «Capabilities unproven — hold»,
 * «Adapter version»). A provider is reached through an adapter (its BB plugin); a new adapter version can break what worked. For every
 * provider in use and the adapter version installed now the table holds a receipt per capability: supported or not_supported, or nothing
 * yet (unproven). The probe is the drill's helper probe (one cheap helper answers «OK»); a provider whose new version fails it is held
 * off by the provider breaker until it answers again.
 */
export const CAPABILITIES = ["answers"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityState = "supported" | "not_supported";
export type CapabilityReceipt = { providerId: string; version: string; capability: Capability; state: CapabilityState; model: string | null; detail: string | null; at: number };

/**
 * The model each provider in use runs, from settings rows (`<stage>.provider` with `<stage>.model`, the PM, the writer), then the base
 * providers every install has with their fallback model (the drill's list, scripts/lp-drill.py `providers_in_use`).
 */
export function providersInUse(rows: ReadonlyArray<{ key: string; value: unknown }>, fallback: Readonly<Record<string, string>> = {}): Map<string, string> {
  const values = new Map(rows.map((row) => [row.key, row.value] as const));
  const found = new Map<string, string>();
  const add = (provider: unknown, model: unknown) => { if (typeof provider === "string" && provider && typeof model === "string" && model && !found.has(provider)) found.set(provider, model); };
  for (const row of rows) if (row.key.endsWith(".provider")) add(row.value, values.get(`${row.key.slice(0, -".provider".length)}.model`));
  add(values.get("pmProviderId"), values.get("pmModel"));
  add(values.get("writerProviderId"), values.get("writerModel"));
  for (const [provider, model] of Object.entries(fallback)) add(provider, model);
  return found;
}

/** The adapter version of each provider: the version of the BB plugin that provides it; null when the plugin is not listed. */
export function adapterVersions(providers: ReadonlyArray<{ id: string; pluginId?: string | null }>, plugins: ReadonlyArray<{ id: string; version?: string | null }>): Map<string, string | null> {
  const version = new Map(plugins.map((plugin) => [plugin.id, plugin.version ?? null] as const));
  return new Map(providers.map((provider) => [provider.id, provider.pluginId ? version.get(provider.pluginId) ?? null : null] as const));
}

/** Providers in use whose installed adapter version has no receipt for a capability yet: the ones to probe. */
export function dueProbes(inUse: ReadonlyMap<string, string>, versions: ReadonlyMap<string, string | null>, receipts: readonly CapabilityReceipt[]): Array<{ providerId: string; model: string; version: string }> {
  const have = new Set(receipts.map((row) => `${row.providerId}\u0000${row.version}\u0000${row.capability}`));
  const out: Array<{ providerId: string; model: string; version: string }> = [];
  for (const [providerId, model] of inUse) {
    const version = versions.get(providerId);
    if (!version) continue;
    if (CAPABILITIES.some((capability) => !have.has(`${providerId}\u0000${version}\u0000${capability}`))) out.push({ providerId, model, version });
  }
  return out;
}

/** The table a person reads: per provider in use, its installed version and each capability's state (unproven when there is no receipt). */
export function capabilityTable(inUse: ReadonlyMap<string, string>, versions: ReadonlyMap<string, string | null>, receipts: readonly CapabilityReceipt[]) {
  return [...inUse.keys()].sort().map((providerId) => {
    const version = versions.get(providerId) ?? null;
    return { providerId, version, capabilities: Object.fromEntries(CAPABILITIES.map((capability) => [capability,
      receipts.find((row) => row.providerId === providerId && row.version === version && row.capability === capability)?.state ?? "unproven"])) as Record<Capability, CapabilityState | "unproven"> };
  });
}
