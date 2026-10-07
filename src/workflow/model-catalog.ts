import { priceFor } from "../model-prices";

/**
 * The hub's catalog of agent providers and their models, as the Workflows tab needs it: every provider BB knows (codex, claude-code,
 * acp-opencode with its Gemini and DeepSeek models, router9 ...), the machines each one is available on, and what each model supports
 * (reasoning efforts). Pure: the server fills it from `bb.sdk.providers`, the browser only reads it, and a choice is checked here
 * before it becomes a draft patch, so a model no machine has never reaches a node.
 */
export type CatalogHost = { id: string; name: string; connected: boolean };
export type CatalogModel = {
  id: string; model: string; displayName: string; efforts: string[]; defaultEffort: string | null;
  /** The machines whose provider lists this model. */
  hostIds: string[];
};
export type CatalogProvider = {
  id: string; displayName: string; logoUrl: string | null; family: string | null;
  supportsServiceTier: boolean; serviceTiers: string[];
  /** The machines the provider is installed and signed in on. */
  hostIds: string[];
  models: CatalogModel[];
};
export type ModelCatalog = { hosts: CatalogHost[]; providers: CatalogProvider[] };

/** The reasoning levels a workflow node can name (the node schema's own list). */
export const NODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Choice = { providerId: string; model: string; effort?: string | null; serviceTier?: string | null };
export type ChoiceError = "provider_unknown" | "provider_unavailable" | "model_unknown" | "model_unavailable" | "effort_unsupported" | "tier_unsupported";
export type ChoiceVerdict = { ok: true } | { ok: false; code: ChoiceError; detail: string };

export const findProvider = (catalog: ModelCatalog, providerId: string): CatalogProvider | undefined => catalog.providers.find((row) => row.id === providerId);
export const findModel = (provider: CatalogProvider | undefined, model: string): CatalogModel | undefined => provider?.models.find((row) => row.id === model || row.model === model);

/**
 * Whether a provider/model/effort/tier combination is something the catalog supports. A provider with no machine is «unavailable»,
 * a model no machine lists is «unavailable» too; an id the catalog has never seen is «unknown». An effort or tier is checked only when given.
 */
export function validateChoice(catalog: ModelCatalog, choice: Choice): ChoiceVerdict {
  const provider = findProvider(catalog, choice.providerId);
  if (!provider) return { ok: false, code: "provider_unknown", detail: choice.providerId };
  if (!provider.hostIds.length) return { ok: false, code: "provider_unavailable", detail: choice.providerId };
  const model = findModel(provider, choice.model);
  if (!model) return { ok: false, code: "model_unknown", detail: `${choice.providerId}/${choice.model}` };
  if (!model.hostIds.length) return { ok: false, code: "model_unavailable", detail: `${choice.providerId}/${choice.model}` };
  if (choice.effort && !model.efforts.includes(choice.effort)) return { ok: false, code: "effort_unsupported", detail: `${choice.model}: ${choice.effort}` };
  if (choice.serviceTier && choice.serviceTier !== "default" && choice.serviceTier !== "standard" && !(provider.supportsServiceTier && provider.serviceTiers.includes(choice.serviceTier))) {
    return { ok: false, code: "tier_unsupported", detail: `${choice.providerId}: ${choice.serviceTier}` };
  }
  return { ok: true };
}

/** The efforts a node may be given for a model: the model's own, narrowed to what the node schema accepts. */
export const nodeEffortsFor = (model: CatalogModel | undefined): string[] => (model ? model.efforts.filter((effort) => (NODE_EFFORTS as readonly string[]).includes(effort)) : []);

export type CostTier = "none" | "low" | "medium" | "high" | "unknown";

/**
 * A rough price class of a model, for choosing where a cheap model will do: from the list price when the model is priced
 * (per 1M output tokens: up to 2 USD low, up to 15 medium, above that high), else from the words in its name.
 */
export function costTier(model: string | null | undefined): CostTier {
  if (!model) return "unknown";
  const price = priceFor(model.slice(model.lastIndexOf("/") + 1));
  if (price) return price.output <= 2 ? "low" : price.output <= 15 ? "medium" : "high";
  const name = model.toLowerCase();
  if (/(^|[-/_ ])(flash|mini|lite|nano|haiku|luna|small|fast|cheap)([-/_ .\d]|$)/.test(name)) return "low";
  if (/opus|pro\b|-pro|astra|ultra|max|large|fable/.test(name)) return "high";
  if (/sonnet|terra|sol|glm|deepseek|kimi|qwen|grok|gemini|gpt|claude/.test(name)) return "medium";
  return "unknown";
}
