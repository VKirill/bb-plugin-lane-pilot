/**
 * Writer models taken in turn when the writer's own model fails for reasons outside the task — a spent limit, a
 * provider error, a model gone from the catalog: the writer's model, then fallback 1, fallback 2, then the PM's
 * model (the emergency writer). Owner's defaults of 2026-10-03: GLM 5.3 Flash, then Gemini 3.8 high (Antigravity
 * through router9); both are in the opencode catalogs of the OVH server and the Mac mini.
 */
export type WriterFallback = { providerId:string; model:string; reasoningLevel:string };

export const WRITER_FALLBACK_SLOTS = [1, 2] as const;

export const WRITER_FALLBACK_DEFAULTS: readonly WriterFallback[] = [
  { providerId:"acp-opencode", model:"zai-coding-plan/glm-5.3-flash", reasoningLevel:"high" },
  { providerId:"acp-opencode", model:"router9/ag/gemini-3.8-flash-high", reasoningLevel:"medium" },
];

export const writerFallbackKeys = (slot:number) => ({
  provider:`writer.fallback${slot}.provider`, model:`writer.fallback${slot}.model`, effort:`writer.fallback${slot}.reasoning_effort`,
});

/** The configured fallbacks in order; an unset slot takes its default, a slot saved with an empty provider is off. */
export function writerFallbacks(settings:Record<string, unknown>):WriterFallback[] {
  return WRITER_FALLBACK_SLOTS.flatMap((slot, index) => {
    const keys = writerFallbackKeys(slot);
    const provider = settings[keys.provider];
    if (provider === undefined || provider === null) return [WRITER_FALLBACK_DEFAULTS[index]!];
    const model = settings[keys.model];
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return [];
    const effort = settings[keys.effort];
    return [{ providerId:provider, model, reasoningLevel:typeof effort === "string" && effort ? effort : "high" }];
  });
}

/** The chain after the writer's own model: its fallbacks, then the PM's model; none repeats the writer or another. */
export function writerFallbackChain(primary:{providerId:string;model:string}, fallbacks:readonly WriterFallback[], pm:{providerId:string;model:string}):Array<WriterFallback & { pm:boolean }> {
  const seen = new Set([`${primary.providerId}/${primary.model}`]);
  const chain:Array<WriterFallback & { pm:boolean }> = [];
  for (const item of [...fallbacks.map((row) => ({ ...row, pm:false })), { ...pm, reasoningLevel:"", pm:true }]) {
    const key = `${item.providerId}/${item.model}`;
    if (!item.providerId || !item.model || seen.has(key)) continue;
    seen.add(key);
    chain.push(item);
  }
  return chain;
}
