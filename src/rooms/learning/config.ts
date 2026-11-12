import { z } from "zod";

/**
 * Learning from the owner's messages (src/learning). The settings are one record in the plugin's key-value store, not project
 * settings: the owner's messages belong to the owner, not to a project, and nothing here needs a settings screen. They are changed
 * with `bb lane-pilot learning config key=value …` or by the PM through `lane_pilot_memory {action:"learned", op:"config", …}`.
 *
 * No model judges a message as it comes. The observer keeps the owner's own messages as raw candidates after a rule-based pre-filter,
 * and one night run of the extractor reads the day's candidates in batches (see extract.ts and service.ts). A record stored by an
 * older version (with `mode`, `sample`, the second opinion's keys) is read without those keys.
 */
export const CONFIG_KEY = "learning:config";

export const configSchema = z.object({
  /** Off: the hook ignores every message. */
  enabled: z.boolean().default(true),
  /** The most candidates kept in a day (UTC); the rest are recorded as skipped. A ceiling on what the night run reads. */
  dailyCandidateCap: z.number().int().min(0).max(5000).default(400),
  /** Extractor runs (one hidden model thread each) in the night pass, and the messages one run reads. */
  nightRuns: z.number().int().min(0).max(48).default(12),
  nightBatch: z.number().int().min(1).max(40).default(25),
  /** Token budgets of the rules in force (replaces the old limit of 12 rules): rules for the PM, rules for writers. */
  pmRulesTokens: z.number().int().min(200).max(8000).default(1600),
  writerRulesTokens: z.number().int().min(200).max(8000).default(1600),
});
export type LearningConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: LearningConfig = configSchema.parse({});

type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };

export async function loadConfig(kv: Pick<Kv, "get">): Promise<LearningConfig> {
  const stored = configSchema.safeParse((await kv.get(CONFIG_KEY)) ?? {});
  return stored.success ? stored.data : DEFAULT_CONFIG;
}

export async function saveConfig(kv: Kv, patch: Partial<LearningConfig>): Promise<LearningConfig> {
  const next = configSchema.parse({ ...(await loadConfig(kv)), ...patch });
  await kv.set(CONFIG_KEY, next as never);
  return next;
}

/** `key=value` words of the CLI as a patch; the value is read as the type of the setting. */
export function parseConfigWords(words: readonly string[]): Partial<LearningConfig> {
  const shape = configSchema.shape as Record<string, z.ZodType>;
  const patch: Record<string, unknown> = {};
  for (const word of words) {
    const at = word.indexOf("=");
    const key = word.slice(0, at), raw = word.slice(at + 1);
    if (at < 1 || !(key in shape)) throw new Error(`unknown setting «${word}»; settings: ${Object.keys(shape).join(", ")}`);
    patch[key] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  // Each value is read by its own setting: a partial schema would fill the rest with defaults and reset them.
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, shape[key]!.parse(value)])) as Partial<LearningConfig>;
}
