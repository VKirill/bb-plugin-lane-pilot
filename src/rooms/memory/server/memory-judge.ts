import { JUDGE_DEFAULTS, JUDGE_FALLBACK_TOP, JUDGE_SYSTEM, RERANK_SYSTEM, TRANSLATE_SYSTEM, gateScore, judgeUserPrompt, lockTermsFor, parseKeywords, pathAnchorsOf, permutationOf, queryHash, readJudgeReply, recordMemoryReceipt, rememberLockTerms, rerankUserPrompt, shuffledBy, translateUserPrompt, type JudgeFallback, type JudgeReceipt, type MemoryRecord, type MemorySettings } from "@lane-pilot/memory-core";
import type { ServerCore } from "../../contracts/server";
import { envCatalogKey } from "../../learning";
import type { LanePilotDatabase } from "../../storage";
import { AgyFailure, agyBinary, agyChat } from "../agy-chat";
import { CodexFailure, codexBinary, codexChat } from "../codex-chat";

/**
 * The last stage of the explicit memory searches (the PM memory tool, `session_memory_search` and so `bb lane-pilot memory search`, the
 * writer's brief): a small model (the local Antigravity CLI for `agy/…` names, local `codex exec` for `codex/…`, 9router for `router9/…`, else OpenLux chat completions) names the notes that help answer the question, or none.
 * The per-turn automatic context of the PM does not come here (4.7 s median, and the PM reads well enough alone).
 *
 * The key is Env Catalog `OPENLUX_MEMORY_API_KEY`, read the way the embeddings read theirs (`envCatalogKey`: the `env-catalog` plugin's
 * `env_get_value`, kept ten minutes in memory, never logged or stored). A failure here never fails a search: a timeout or any other trouble
 * hands back the vector's first five without a warning, and the receipt says why.
 */
export const JUDGE_KEY_NAME = "OPENLUX_MEMORY_API_KEY";
export const JUDGE_BASE_URL = "https://api.openlux.ai/v1";
/** A model named `router9/<id>` goes to the owner's 9router (Gemini on the Antigravity subscription) with its own key; any other name goes to OpenLux. */
export const ROUTER9_PREFIX = "router9/";
export const ROUTER9_KEY_NAME = "NINEROUTER_API_KEY";
export const ROUTER9_BASE_URL = "https://9router.vechkasov.pro/v1";
/** 9router answers a spent Antigravity window with 403/429 «reset after 2m»: the route is skipped that long and the fallback is asked at once. */
const ROUTE_LOCK_MS = 2 * 60_000;
const CACHE_TTL_MS = 10 * 60_000, CACHE_MAX = 500, MAX_TOKENS = 1500;

/** A model named `agy/<id>` runs through the Antigravity CLI on this machine (the owner's sign-in, no key); `<id>` is an `agy models` id. */
export const AGY_PREFIX = "agy/";
/** A model named `codex/<id>` runs through `codex exec` on this machine, stripped to the bone (codex-chat.ts); `<id>` is a Codex model id such as `gpt-6-luna`. */
export const CODEX_PREFIX = "codex/";

/** Where a model name is sent: the base URL, the key, and the model id that endpoint knows; `chat` replaces the HTTP call (the `agy` route). */
export type JudgeRoute = { name: string; baseUrl: string; key: () => Promise<string | undefined>; model: string; chat?: (model: string, system: string, user: string, timeoutMs: number) => Promise<Chat> };
export type JudgeRoutes = (model: string) => JudgeRoute;

export type JudgeSettings = { model: string; fallbackModel: string; timeoutMs: number;
  /** `rerank`: the judge returns every candidate in a new order and never none; `filter` (unset) names the helpful ones. */
  mode?: "filter" | "rerank" };
export type JudgeOutcome = {
  /** The notes named, in the order of the candidates; `null` when the judge gave no usable answer (the caller falls back). */
  chosen: MemoryRecord[] | null;
  receipt: Omit<JudgeReceipt, "surface" | "gate">;
};
export type JudgeInput = { query: string; candidates: readonly MemoryRecord[]; settings: JudgeSettings };
/** The judge call; `translate` (set by `openLuxJudge`) makes the English keywords of a question for the door lock, cached per question, null when the call failed. */
export type MemoryJudge = ((input: JudgeInput) => Promise<JudgeOutcome>) & { translate?: (query: string, settings: JudgeSettings) => Promise<string[] | null> };

class HttpFailure extends Error { constructor(message: string, readonly status = 0) { super(message); } }
class JudgeTimeout extends Error {}

type Chat = { content: string; tokensIn: number; tokensOut: number };

export function openLuxJudge(key: () => Promise<string | undefined>, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, baseUrl = JUDGE_BASE_URL, routes?: JudgeRoutes): MemoryJudge {
  const cache = new Map<string, { at: number; ids: string[] }>();
  const routeOf: JudgeRoutes = routes ?? ((model) => ({ name: "openlux", baseUrl, key, model }));
  const lockedUntil = new Map<string, number>();

  async function chat(route: JudgeRoute, apiKey: string, system: string, user: string, timeoutMs: number): Promise<Chat> {
    if (route.chat) {
      try { return await route.chat(route.model, system, user, timeoutMs); }
      catch (cause) {
        if ((cause instanceof AgyFailure || cause instanceof CodexFailure) && cause.timedOut) throw new JudgeTimeout("timeout");
        throw new HttpFailure(cause instanceof Error ? cause.message : String(cause), cause instanceof AgyFailure || cause instanceof CodexFailure ? cause.status : 0);
      }
    }
    const routeBase = route.baseUrl, model = route.model;
    let response: Response;
    try {
      response = await fetchImpl(`${routeBase}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        body: JSON.stringify({ model, temperature: 0, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      throw name === "TimeoutError" || name === "AbortError" ? new JudgeTimeout("timeout") : new HttpFailure(`network: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!response.ok) throw new HttpFailure(`http ${response.status}`, response.status);
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = body.choices?.[0]?.message?.content;
      return { content: typeof content === "string" ? content : "", tokensIn: body.usage?.prompt_tokens ?? 0, tokensOut: body.usage?.completion_tokens ?? 0 };
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      throw name === "TimeoutError" || name === "AbortError" ? new JudgeTimeout("timeout") : new HttpFailure("unreadable body");
    }
  }

  const translations = new Map<string, string[]>();
  const translate = async (query: string, settings: JudgeSettings): Promise<string[] | null> => {
    const key = queryHash(query);
    const known = translations.get(key);
    if (known) return known;
    for (const model of [settings.model, settings.fallbackModel]) {
      if (!model) continue;
      const route = routeOf(model);
      const apiKey = await route.key().catch(() => undefined);
      if (!apiKey) continue;
      try {
        const terms = parseKeywords((await chat(route, apiKey, TRANSLATE_SYSTEM, translateUserPrompt(query), settings.timeoutMs)).content);
        if (!terms.length) continue;
        translations.set(key, terms);
        if (translations.size > CACHE_MAX) translations.delete(translations.keys().next().value!);
        return terms;
      } catch { /* the next model, then the literal lock */ }
    }
    return null;
  };

  const judge = async ({ query, candidates, settings }: JudgeInput): Promise<JudgeOutcome> => {
    const started = now();
    const ids = candidates.map((record) => record.id);
    const rerank = settings.mode === "rerank";
    let unparsed = 0;
    const base = { model: settings.model, candidates: ids, chosen: [] as string[], tokensIn: 0, tokensOut: 0, ...(rerank ? { mode: "rerank" as const } : {}) };
    const failed = (fallback: JudgeFallback, extra: Partial<JudgeReceipt> = {}): JudgeOutcome => ({ chosen: null, receipt: { ...base, ...extra, ...(unparsed ? { unparsed } : {}), latencyMs: now() - started, fallback } });
    const primary = routeOf(settings.model);
    const secondary = settings.fallbackModel && settings.fallbackModel !== settings.model ? routeOf(settings.fallbackModel) : null;
    const keyOf = async (route: JudgeRoute) => route.key().catch(() => undefined);
    const primaryKey = await keyOf(primary);
    const primaryLocked = (lockedUntil.get(primary.name) ?? 0) > started;
    if (!primaryKey && !secondary) return failed("no_key");

    const cacheKey = `${rerank ? "r" : "f"}|${queryHash(query)}|${[...ids].sort().join(",")}`;
    const hit = cache.get(cacheKey);
    if (hit && started - hit.at < CACHE_TTL_MS) {
      const byId = new Map(candidates.map((record) => [record.id, record]));
      const chosen = rerank ? hit.ids.map((id) => byId.get(id)!).filter(Boolean) : candidates.filter((record) => hit.ids.includes(record.id));
      return { chosen, receipt: { ...base, chosen: chosen.map((record) => record.id), latencyMs: 0, cached: true } };
    }

    // The filter shows the notes in a seeded shuffle (the order is no hint); the reranker shows them in the order the search gave, which is the «previous order» it falls back to.
    const shuffled = rerank ? [...candidates] : shuffledBy(candidates, query);
    const user = rerank ? rerankUserPrompt(query, shuffled) : judgeUserPrompt(query, shuffled);
    const system = rerank ? RERANK_SYSTEM : JUDGE_SYSTEM;
    const answer = (reply: string): MemoryRecord[] | null => {
      const read = readJudgeReply(reply, shuffled.length);
      if (!read) { unparsed = 1; return null; }
      unparsed = read.dropped;
      if (rerank) {
        // «None» is not an answer of a reranker: no number read is an unparsed reply, and the caller keeps the previous order.
        if (!read.numbers.length) { unparsed = Math.max(1, read.dropped); return null; }
        return permutationOf(read.numbers, shuffled.length).map((number) => shuffled[number - 1]!);
      }
      const named = new Set(read.numbers.map((number) => shuffled[number - 1]!.id));
      return candidates.filter((record) => named.has(record.id));
    };
    const done = (chosen: MemoryRecord[], used: Chat, extra: Partial<JudgeReceipt> = {}): JudgeOutcome => {
      cache.set(cacheKey, { at: started, ids: chosen.map((record) => record.id) });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return { chosen, receipt: { ...base, ...extra, ...(unparsed ? { unparsed } : {}), chosen: chosen.map((record) => record.id), latencyMs: now() - started, tokensIn: used.tokensIn, tokensOut: used.tokensOut } };
    };

    // The fallback: the same window when it is on the same endpoint (one budget), a fresh one on another endpoint (the first may have
    // spent its time on a lock or a hang that says nothing about the second).
    const retry = async (sameRoute: boolean): Promise<JudgeOutcome> => {
      const left = sameRoute ? settings.timeoutMs - (now() - started) : settings.timeoutMs;
      if (!secondary || left < 500) return failed("http_error");
      const secondKey = await keyOf(secondary);
      if (!secondKey) return failed("no_key");
      try {
        const second = await chat(secondary, secondKey, system, user, left);
        const chosen = answer(second.content);
        return chosen ? done(chosen, second, { retriedWith: settings.fallbackModel }) : failed("retry_failed", { retriedWith: settings.fallbackModel, tokensIn: second.tokensIn, tokensOut: second.tokensOut });
      } catch { return failed("retry_failed", { retriedWith: settings.fallbackModel }); }
    };
    const otherRoute = !secondary || secondary.name !== primary.name;
    if (!primaryKey || (primaryLocked && otherRoute)) return retry(false);

    let first: Chat;
    try { first = await chat(primary, primaryKey, system, user, settings.timeoutMs); }
    catch (cause) {
      const locking = cause instanceof JudgeTimeout || (cause instanceof HttpFailure && (cause.status === 403 || cause.status === 429));
      if (locking && otherRoute && secondary) lockedUntil.set(primary.name, now() + ROUTE_LOCK_MS);
      if (cause instanceof JudgeTimeout && !otherRoute) return failed("timeout");
      if (cause instanceof JudgeTimeout && !secondary) return failed("timeout");
      // An HTTP error (or a timeout on an endpoint the fallback does not share): one more try with the fallback model.
      return retry(!otherRoute);
    }
    const chosen = answer(first.content);
    return chosen ? done(chosen, first) : failed("unparsed", { tokensIn: first.tokensIn, tokensOut: first.tokensOut });
  };
  return Object.assign(judge, { translate });
}

let shared: MemoryJudge | null = null;
/** The judge of this server, set by `mountMemoryJudge`; tests may set their own. */
export const setMemoryJudge = (judge: MemoryJudge | null): void => { shared = judge; };
export const currentMemoryJudge = (): MemoryJudge | null => shared;

export function mountMemoryJudge(ctx: ServerCore): void {
  const openLuxKey = envCatalogKey(ctx.bb, JUDGE_KEY_NAME);
  const router9Key = envCatalogKey(ctx.bb, ROUTER9_KEY_NAME);
  setMemoryJudge(openLuxJudge(openLuxKey, fetch, Date.now, JUDGE_BASE_URL, judgeRoutes(openLuxKey, router9Key)));
}

/** `agy/<id>` → the local Antigravity CLI; `router9/<id>` → 9router with its key; anything else → OpenLux. */
export function judgeRoutes(openLuxKey: () => Promise<string | undefined>, router9Key: () => Promise<string | undefined>, agy: JudgeRoute["chat"] = agyChat, agyReady: () => Promise<string | undefined> = async () => (agyBinary() ? "local" : undefined), codex: JudgeRoute["chat"] = codexChat, codexReady: () => Promise<string | undefined> = async () => (codexBinary() ? "local" : undefined)): JudgeRoutes {
  return (model) => model.startsWith(AGY_PREFIX)
    ? { name: "agy", baseUrl: "", key: agyReady, model: model.slice(AGY_PREFIX.length), chat: agy }
    : model.startsWith(CODEX_PREFIX)
    ? { name: "codex", baseUrl: "", key: codexReady, model: model.slice(CODEX_PREFIX.length), chat: codex }
    : model.startsWith(ROUTER9_PREFIX)
    ? { name: "router9", baseUrl: ROUTER9_BASE_URL, key: router9Key, model: model.slice(ROUTER9_PREFIX.length) }
    : { name: "openlux", baseUrl: JUDGE_BASE_URL, key: openLuxKey, model };
}

export type JudgeSurface = JudgeReceipt["surface"];

/**
 * The English keywords of a question for the door lock, made before the (synchronous) search and kept for it (`rememberLockTerms`): one call of the
 * judge's own route, cached per question. A no-op unless `memory.door_lock = translated`; a failed call leaves no terms, and the lock is the literal one.
 */
export async function translateForLock(query: string, memory: MemorySettings): Promise<string[] | null> {
  if (memory.doorLock !== "translated") return null;
  const known = lockTermsFor(query);
  if (known) return known;
  const judge = currentMemoryJudge();
  if (!judge?.translate) return null;
  try {
    const terms = await judge.translate(query, { model: memory.judgeModel ?? JUDGE_DEFAULTS.model, fallbackModel: memory.judgeFallbackModel ?? JUDGE_DEFAULTS.fallbackModel, timeoutMs: memory.judgeTimeoutMs ?? JUDGE_DEFAULTS.timeoutMs });
    if (terms?.length) rememberLockTerms(query, terms);
    return terms;
  } catch { return null; }
}

/**
 * The notes of an explicit search after the judge. `found` is the search after the relevance floor, best first. The judge reads the first
 * `memory.judge.candidates` of them; a note that names a path written in the question is kept whatever the judge says (the path override),
 * and so is every `pinned` id (`memory.pinned`: outside the judge's reach, always delivered, first).
 * `memory.judge.mode`: `filter` (default) keeps the notes the judge names, or none; `rerank` gives back every note, the judged candidates in the
 * judge's order and the rest as they came, so the answer is never shorter than `found` and never empty (a timeout, an error or an unreadable
 * reply leaves the previous order). Without a judge (off, no embedder) the list is `found` as it came.
 * A filter judge that fails gives the first five by cosine and no warning.
 */
export async function judgeFound(db: LanePilotDatabase, input: { projectId: string; query: string; found: readonly MemoryRecord[]; memory: MemorySettings; surface: JudgeSurface; audience?: "subagent" | "owner" | "export"; pinned?: ReadonlySet<string> }): Promise<{ records: MemoryRecord[]; judged: boolean }> {
  const { found, memory, query } = input;
  const judge = currentMemoryJudge();
  if (!judge || memory.judgeEnabled === false || !found.length) return { records: [...found], judged: false };
  const rerank = memory.judgeMode === "rerank";
  const pinned = input.pinned ?? new Set<string>();
  const anchors = pathAnchorsOf(query);
  const anchored = new Set(anchors.length ? found.filter((record) => anchors.some((anchor) => record.content.includes(anchor))).map((record) => record.id) : []);
  const candidates = found.filter((record) => !anchored.has(record.id) && !pinned.has(record.id)).slice(0, memory.judgeCandidates ?? JUDGE_DEFAULTS.candidates);
  let outcome: JudgeOutcome;
  if (!candidates.length) return { records: [...found], judged: false };
  try {
    outcome = await judge({ query, candidates, settings: { model: memory.judgeModel ?? JUDGE_DEFAULTS.model, fallbackModel: memory.judgeFallbackModel ?? JUDGE_DEFAULTS.fallbackModel, timeoutMs: memory.judgeTimeoutMs ?? JUDGE_DEFAULTS.timeoutMs, ...(rerank ? { mode: "rerank" as const } : {}) } });
  } catch {
    outcome = { chosen: null, receipt: { model: memory.judgeModel ?? JUDGE_DEFAULTS.model, candidates: candidates.map((record) => record.id), chosen: [], latencyMs: 0, tokensIn: 0, tokensOut: 0, fallback: "http_error", ...(rerank ? { mode: "rerank" as const } : {}) } };
  }
  let records: MemoryRecord[];
  if (rerank) {
    const order = outcome.chosen ?? candidates;
    const placed = new Set(order.map((record) => record.id));
    records = [...found.filter((record) => pinned.has(record.id)), ...found.filter((record) => anchored.has(record.id) && !pinned.has(record.id)), ...order, ...found.filter((record) => !placed.has(record.id) && !anchored.has(record.id) && !pinned.has(record.id))];
  } else {
    const picked = outcome.chosen ?? candidates.slice(0, JUDGE_FALLBACK_TOP);
    const keep = new Set([...anchored, ...pinned, ...picked.map((record) => record.id)]);
    records = found.filter((record) => keep.has(record.id));
  }
  try {
    const gate = gateScore(db, input.projectId, query, found, { audience: input.audience ?? "subagent", personalBot: memory.personalBot });
    recordMemoryReceipt(db, { projectId: input.projectId, role: `judge:${input.surface}`, returnedIds: candidates.map((record) => record.id), packedIds: records.map((record) => record.id), tokens: outcome.receipt.tokensIn + outcome.receipt.tokensOut,
      judge: { ...outcome.receipt, surface: input.surface, gate } });
  } catch { /* a receipt that cannot be written never fails the search */ }
  return { records, judged: true };
}
