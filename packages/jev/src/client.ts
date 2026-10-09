import { JEV_PROVIDERS, type JevProvider } from "./provider";
import type { JevAnswer, JevBudget, JevCallResult, JevQuestion, JevUsage } from "./types";

/**
 * The one place that talks to `POST <provider url>/v1/systemone` (TypeSafe or OpenLux, `./provider`). The key comes from the endpoint
 * reader (the server reads it from the Env Catalog record of the chosen provider), never from the state or a setting. A request has
 * a timeout (the caller's plus the provider's headroom), at most one retry (408, 429, 5xx, network; 401, 422 and OpenLux's 500
 * `invalid_request` are our own faults and are not retried), a cap of requests in flight, an optional run
 * budget, and a breaker that stops asking after repeated failures. It never throws: a failure is a result the caller turns
 * into its deterministic fallback.
 */
export const JEV_URL = JEV_PROVIDERS.typesafe.url;
export const DEFAULT_MODEL = JEV_PROVIDERS.typesafe.model;
export const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_IN_FLIGHT = 16;
const BREAKER_FAILURES = 5;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_OPEN_MS = 5 * 60_000;
const RETRY_PAUSE_MS = 300;
const RETRY_PAUSE_MAX_MS = 2_000;
/** TypeSafe: 64k tokens a request, 32k of them for the state and the longest question. About 3 characters a token for Russian text. */
export const MAX_STATE_CHARS = 80_000;

export type JevRequest = { state: unknown; questions: Record<string, JevQuestion>; model?: string };
export type JevCallOptions = { timeoutMs?: number; budget?: JevBudget | undefined; signal?: AbortSignal | undefined };

/** Where the next call goes: the provider (url, model, headroom) and its key, read together so a key never meets another provider's url. */
export type JevEndpoint = { provider: JevProvider; apiKey: string | undefined };

export type JevClientDeps = {
  endpoint(): Promise<JevEndpoint>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type JevClient = {
  call(request: JevRequest, options?: JevCallOptions): Promise<JevCallResult>;
  /** Breaker state, for the status line and tests. */
  breaker(): { open: boolean; failures: number };
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export function createJevClient(deps: JevClientDeps): JevClient {
  const doFetch = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let failures: number[] = [];
  let openUntil = 0;
  let inFlight = 0;
  const waiting: Array<() => void> = [];

  const recordFailure = (): void => {
    const at = now();
    failures = [...failures.filter((time) => at - time < BREAKER_WINDOW_MS), at];
    if (failures.length >= BREAKER_FAILURES) { openUntil = at + BREAKER_OPEN_MS; failures = []; }
  };

  async function once(url: string, body: string, key: string, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; json?: unknown; retryAfterMs?: number; error?: string; timedOut?: boolean; badRequest?: boolean }> {
    try {
      const response = await doFetch(url, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
      if (!response.ok) {
        // OpenLux answers a malformed request with 500 and code invalid_request (TypeSafe: 422): ours to fix, not worth a retry or a breaker count.
        const badRequest = response.status === 500 && await Promise.resolve(response.json?.()).then((json: { error?: { code?: unknown } } | null) => json?.error?.code === "invalid_request", () => false);
        return { status: response.status, ...(retryAfterMs ? { retryAfterMs } : {}), ...(badRequest ? { badRequest } : {}), error: badRequest ? "http 500 invalid_request" : `http ${response.status}` };
      }
      return { status: 200, json: await response.json() };
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      return { status: 0, error: timedOut ? "timeout" : cause instanceof Error ? cause.message : String(cause), timedOut };
    }
  }

  return {
    breaker: () => ({ open: now() < openUntil, failures: failures.length }),
    async call(request, options = {}) {
      const started = now();
      const fail = (status: Exclude<JevCallResult, { ok: true }>["status"], error: string, attempts = 0): JevCallResult => ({ ok: false, status, error, latencyMs: now() - started, attempts });
      const endpoint = await deps.endpoint().catch(() => undefined);
      if (!endpoint) return fail("disabled", "no Jev endpoint");
      const { provider } = endpoint, key = endpoint.apiKey?.trim();
      if (!key) return fail("disabled", `no ${provider.keyName}`);
      if (now() < openUntil) return fail("breaker_open", "too many recent failures");
      const body = JSON.stringify({ state: request.state, model: request.model ?? provider.model, questions: request.questions });
      if (body.length > MAX_STATE_CHARS + 200_000) return fail("invalid", `request is ${body.length} characters`);
      if (options.budget) {
        if (options.budget.remaining <= 0) return fail("budget", "the run's Jev request budget is spent");
        options.budget.remaining -= 1;
      }
      if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((ready) => waiting.push(ready));
      inFlight += 1;
      try {
        const timeoutMs = (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + provider.timeoutPadMs;
        let attempts = 0, last: Awaited<ReturnType<typeof once>> = { status: 0, error: "not sent" };
        for (; attempts < 2; ) {
          attempts += 1;
          last = await once(provider.url, body, key, timeoutMs, options.signal);
          if (last.status === 200) break;
          if (options.signal?.aborted || last.badRequest || !(last.status === 0 || RETRYABLE.has(last.status))) break;
          if (attempts < 2) await sleep(Math.min(RETRY_PAUSE_MAX_MS, last.retryAfterMs ?? RETRY_PAUSE_MS));
        }
        if (last.status !== 200) {
          // 401, 422 and a 500 invalid_request say our key or request is wrong: they must not trip the breaker for a healthy service, but do not retry either.
          if (!last.badRequest && (last.status === 0 || last.status >= 429 || last.status === 408)) recordFailure();
          return fail(last.timedOut ? "timeout" : "error", last.error ?? `http ${last.status}`, attempts);
        }
        const parsed = parseResponse(last.json, request.questions, provider.model);
        if (!parsed.ok) { recordFailure(); return fail("invalid", parsed.error, attempts); }
        failures = [];
        return { ok: true, answers: parsed.answers, model: parsed.model, usage: parsed.usage, latencyMs: now() - started, attempts };
      } finally {
        inFlight -= 1;
        waiting.shift()?.();
      }
    },
  };
}

function parseResponse(json: unknown, questions: Record<string, JevQuestion>, defaultModel: string): { ok: true; answers: Record<string, JevAnswer>; model: string; usage: JevUsage } | { ok: false; error: string } {
  const body = json as { answers?: Record<string, unknown>; model?: unknown; usage?: Partial<JevUsage> } | null;
  if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") return { ok: false, error: "no answers in the response" };
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id] as Record<string, unknown> | undefined;
    if (!answer || answer.type !== question.type) return { ok: false, error: `answer ${id} is missing or not a ${question.type}` };
    if (question.type === "noul" && typeof answer.noul !== "number") return { ok: false, error: `answer ${id} has no number` };
    if (question.type !== "noul" && (typeof answer.probabilities !== "object" || !answer.probabilities)) return { ok: false, error: `answer ${id} has no probabilities` };
    answers[id] = answer as unknown as JevAnswer;
  }
  return { ok: true, answers, model: typeof body.model === "string" ? body.model : defaultModel, usage: { input_tokens: Number(body.usage?.input_tokens) || 0, output_tokens: Number(body.usage?.output_tokens) || 0 } };
}
