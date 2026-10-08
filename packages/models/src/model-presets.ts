/**
 * Named model presets a workflow node may ask for with `model_preset`. A preset is a named setting: `workflow.preset.<slug>.provider`,
 * `.model` and `.reasoning_effort` in Settings, with the defaults below when Settings say nothing. The chains name them as `cheap-fast`,
 * `strong` and the Insights presets of the social-insights skill («INS - анализ (Claude Opus 5)»); the long names are aliases of a slug.
 * Pure on purpose: the validator, the Models view and the executor all read presets from here.
 */
export type PresetTuple = { providerId: string; model: string; reasoning: string | null };
type BuiltinPreset = {
  providerId: string; model: string; reasoning: string;
  /** The names the shipped chains and the skill use for the preset, besides its slug. */
  aliases: readonly string[];
};

export const BUILTIN_PRESETS: Readonly<Record<string, BuiltinPreset>> = {
  // A fast, cheap model every claude-code machine offers; the bulk steps (collect, extract, send) of the chains.
  "cheap-fast": { providerId: "claude-code", model: "claude-haiku-5-5", reasoning: "low", aliases: [] },
  strong: { providerId: "claude-code", model: "claude-opus-5-5", reasoning: "high", aliases: [] },
  // The Insights pipeline (skills/social-insights/references/pipeline.md): the model each stage's BB Tasks preset names.
  "ins-analysis": { providerId: "claude-code", model: "claude-opus-5", reasoning: "high", aliases: ["INS - анализ"] },
  "ins-psychology": { providerId: "codex", model: "gpt-5.6-luna", reasoning: "max", aliases: ["INS - психология"] },
  "ins-check": { providerId: "acp-cursor", model: "grok-4.6", reasoning: "medium", aliases: ["INS - проверка"] },
  "ins-digest": { providerId: "claude-code", model: "claude-sonnet-5", reasoning: "medium", aliases: ["INS - сводка"] },
};
export const PRESET_SLUGS = Object.keys(BUILTIN_PRESETS);

export const PRESET_FIELDS = ["provider", "model", "reasoning_effort"] as const;
export const presetKey = (slug: string, field: (typeof PRESET_FIELDS)[number]) => `workflow.preset.${slug}.${field}`;

/** «INS — анализ (Claude Opus 5)» and «ins - анализ» are the same name: dashes, case, spaces and a trailing parenthesis do not count. */
const norm = (name: string) => name.toLowerCase().replace(/[—–]/g, "-").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();

/** The slug a preset name stands for, or null when it names no preset. */
export function presetSlug(name: string): string | null {
  const wanted = norm(name);
  return PRESET_SLUGS.find((slug) => slug === wanted || BUILTIN_PRESETS[slug]!.aliases.some((alias) => norm(alias) === wanted)) ?? null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** What a preset runs on: its settings when both provider and model are set, else the built-in default; an effort setting wins either way. */
export function presetSelection(slug: string, settings: Record<string, unknown>): PresetTuple | null {
  const builtin = BUILTIN_PRESETS[slug];
  if (!builtin) return null;
  const provider = text(settings[presetKey(slug, "provider")]), model = text(settings[presetKey(slug, "model")]);
  const effort = text(settings[presetKey(slug, "reasoning_effort")]);
  const pair = provider && model ? { providerId: provider, model } : { providerId: builtin.providerId, model: builtin.model };
  return { ...pair, reasoning: effort ?? (provider && model ? null : builtin.reasoning) };
}
