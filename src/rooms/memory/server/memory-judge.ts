import { JUDGE_DEFAULTS, JUDGE_FALLBACK_TOP, JUDGE_SYSTEM, gateScore, judgeUserPrompt, parseJudgeReply, pathAnchorsOf, queryHash, recordMemoryReceipt, shuffledBy, type JudgeFallback, type JudgeReceipt, type MemoryRecord, type MemorySettings } from "@lane-pilot/memory-core";
import type { ServerCore } from "../../contracts/server";
import { envCatalogKey } from "../../learning";
import type { LanePilotDatabase } from "../../storage";

/**
 * The last stage of the explicit memory searches (the PM memory tool, `session_memory_search` and so `bb lane-pilot memory search`, the
 * writer's brief): a small model on OpenLux (OpenAI-compatible chat completions) names the notes that help answer the question, or none.
 * The per-turn automatic context of the PM does not come here (4.7 s median, and the PM reads well enough alone).
 *
 * The key is Env Catalog `OPENLUX_MEMORY_API_KEY`, read the way the embeddings read theirs (`envCatalogKey`: the `env-catalog` plugin's
 * `env_get_value`, kept ten minutes in memory, never logged or stored). A failure here never fails a search: a timeout or any other trouble
 * hands back the vector's first five without a warning, and the receipt says why.
 */
export const JUDGE_KEY_NAME = "OPENLUX_MEMORY_API_KEY";
export const JUDGE_BASE_URL = "https://api.openlux.ai/v1";
const CACHE_TTL_MS = 10 * 60_000, CACHE_MAX = 500, MAX_TOKENS = 1500;

export type JudgeSettings = { model: string; fallbackModel: string; timeoutMs: number };
export type JudgeOutcome = {
  /** The notes named, in the order of the candidates; `null` when the judge gave no usable answer (the caller falls back). */
  chosen: MemoryRecord[] | null;
  receipt: Omit<JudgeReceipt, "surface" | "gate">;
};
export type MemoryJudge = (input: { query: string; candidates: readonly MemoryRecord[]; settings: JudgeSettings }) => Promise<JudgeOutcome>;

class HttpFailure extends Error {}
class JudgeTimeout extends Error {}

type Chat = { content: string; tokensIn: number; tokensOut: number };

export function openLuxJudge(key: () => Promise<string | undefined>, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, baseUrl = JUDGE_BASE_URL): MemoryJudge {
  const cache = new Map<string, { at: number; ids: string[] }>();

  async function chat(apiKey: string, model: string, system: string, user: string, timeoutMs: number): Promise<Chat> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        body: JSON.stringify({ model, temperature: 0, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      throw name === "TimeoutError" || name === "AbortError" ? new JudgeTimeout("timeout") : new HttpFailure(`network: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!response.ok) throw new HttpFailure(`http ${response.status}`);
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = body.choices?.[0]?.message?.content;
      return { content: typeof content === "string" ? content : "", tokensIn: body.usage?.prompt_tokens ?? 0, tokensOut: body.usage?.completion_tokens ?? 0 };
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      throw name === "TimeoutError" || name === "AbortError" ? new JudgeTimeout("timeout") : new HttpFailure("unreadable body");
    }
  }

  return async ({ query, candidates, settings }) => {
    const started = now();
    const ids = candidates.map((record) => record.id);
    const base = { model: settings.model, candidates: ids, chosen: [] as string[], tokensIn: 0, tokensOut: 0 };
    const failed = (fallback: JudgeFallback, extra: Partial<JudgeReceipt> = {}): JudgeOutcome => ({ chosen: null, receipt: { ...base, ...extra, latencyMs: now() - started, fallback } });
    const apiKey = await key().catch(() => undefined);
    if (!apiKey) return failed("no_key");

    const cacheKey = `${queryHash(query)}|${[...ids].sort().join(",")}`;
    const hit = cache.get(cacheKey);
    if (hit && started - hit.at < CACHE_TTL_MS) {
      const chosen = candidates.filter((record) => hit.ids.includes(record.id));
      return { chosen, receipt: { ...base, chosen: chosen.map((record) => record.id), latencyMs: 0, cached: true } };
    }

    const shuffled = shuffledBy(candidates, query);
    const user = judgeUserPrompt(query, shuffled);
    const answer = (reply: string): MemoryRecord[] | null => {
      const numbers = parseJudgeReply(reply, shuffled.length);
      if (!numbers) return null;
      const named = new Set(numbers.map((number) => shuffled[number - 1]!.id));
      return candidates.filter((record) => named.has(record.id));
    };
    const done = (chosen: MemoryRecord[], used: Chat, extra: Partial<JudgeReceipt> = {}): JudgeOutcome => {
      cache.set(cacheKey, { at: started, ids: chosen.map((record) => record.id) });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return { chosen, receipt: { ...base, ...extra, chosen: chosen.map((record) => record.id), latencyMs: now() - started, tokensIn: used.tokensIn, tokensOut: used.tokensOut } };
    };

    let first: Chat;
    try { first = await chat(apiKey, settings.model, JUDGE_SYSTEM, user, settings.timeoutMs); }
    catch (cause) {
      if (cause instanceof JudgeTimeout) return failed("timeout");
      // An HTTP error (not a timeout): one more try with the fallback model inside what is left of the time.
      const left = settings.timeoutMs - (now() - started);
      if (!settings.fallbackModel || settings.fallbackModel === settings.model || left < 500) return failed("http_error");
      try {
        const second = await chat(apiKey, settings.fallbackModel, JUDGE_SYSTEM, user, left);
        const chosen = answer(second.content);
        return chosen ? done(chosen, second, { retriedWith: settings.fallbackModel }) : failed("retry_failed", { retriedWith: settings.fallbackModel, tokensIn: second.tokensIn, tokensOut: second.tokensOut });
      } catch { return failed("retry_failed", { retriedWith: settings.fallbackModel }); }
    }
    const chosen = answer(first.content);
    return chosen ? done(chosen, first) : failed("unparsed", { tokensIn: first.tokensIn, tokensOut: first.tokensOut });
  };
}

let shared: MemoryJudge | null = null;
/** The judge of this server, set by `mountMemoryJudge`; tests may set their own. */
export const setMemoryJudge = (judge: MemoryJudge | null): void => { shared = judge; };
export const currentMemoryJudge = (): MemoryJudge | null => shared;

export function mountMemoryJudge(ctx: ServerCore): void {
  setMemoryJudge(openLuxJudge(envCatalogKey(ctx.bb, JUDGE_KEY_NAME)));
}

export type JudgeSurface = JudgeReceipt["surface"];

/**
 * The notes of an explicit search after the judge. `found` is the search after the relevance floor, best first. The judge reads the first
 * `memory.judge.candidates` of them; a note that names a path written in the question is kept whatever the judge says (the path override).
 * `kept` is how many notes the caller wants at most. Without a judge (off, no embedder) the list is `found` as it came.
 * A judge that fails gives the first five by cosine and no warning.
 */
export async function judgeFound(db: LanePilotDatabase, input: { projectId: string; query: string; found: readonly MemoryRecord[]; memory: MemorySettings; surface: JudgeSurface; audience?: "subagent" | "owner" | "export" }): Promise<{ records: MemoryRecord[]; judged: boolean }> {
  const { found, memory, query } = input;
  const judge = currentMemoryJudge();
  if (!judge || memory.judgeEnabled === false || !found.length) return { records: [...found], judged: false };
  const anchors = pathAnchorsOf(query);
  const anchored = new Set(anchors.length ? found.filter((record) => anchors.some((anchor) => record.content.includes(anchor))).map((record) => record.id) : []);
  const candidates = found.filter((record) => !anchored.has(record.id)).slice(0, memory.judgeCandidates ?? JUDGE_DEFAULTS.candidates);
  let outcome: JudgeOutcome;
  if (!candidates.length) return { records: [...found], judged: false };
  try {
    outcome = await judge({ query, candidates, settings: { model: memory.judgeModel ?? JUDGE_DEFAULTS.model, fallbackModel: memory.judgeFallbackModel ?? JUDGE_DEFAULTS.fallbackModel, timeoutMs: memory.judgeTimeoutMs ?? JUDGE_DEFAULTS.timeoutMs } });
  } catch {
    outcome = { chosen: null, receipt: { model: memory.judgeModel ?? JUDGE_DEFAULTS.model, candidates: candidates.map((record) => record.id), chosen: [], latencyMs: 0, tokensIn: 0, tokensOut: 0, fallback: "http_error" } };
  }
  const picked = outcome.chosen ?? candidates.slice(0, JUDGE_FALLBACK_TOP);
  const keep = new Set([...anchored, ...picked.map((record) => record.id)]);
  const records = found.filter((record) => keep.has(record.id));
  try {
    const gate = gateScore(db, input.projectId, query, found, { audience: input.audience ?? "subagent", personalBot: memory.personalBot });
    recordMemoryReceipt(db, { projectId: input.projectId, role: `judge:${input.surface}`, returnedIds: candidates.map((record) => record.id), packedIds: records.map((record) => record.id), tokens: outcome.receipt.tokensIn + outcome.receipt.tokensOut,
      judge: { ...outcome.receipt, surface: input.surface, gate } });
  } catch { /* a receipt that cannot be written never fails the search */ }
  return { records, judged: true };
}
