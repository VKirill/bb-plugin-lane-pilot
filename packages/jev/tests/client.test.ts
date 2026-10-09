import { describe, expect, it, vi } from "vitest";
import { JEV_PROVIDERS, createJevClient, resolveJevProvider } from "@lane-pilot/jev";
import type { JevProvider } from "@lane-pilot/jev";
import type { JevQuestion } from "@lane-pilot/jev";

const QUESTIONS: Record<string, JevQuestion> = { urgent: { type: "noul", instructions: "Is it urgent?" } };
const OK_BODY = { model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 10 } };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "throw" | "timeout";
function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; auth: string | null; body: any }> = [];
  const fn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, auth: init.headers.authorization ?? null, body: JSON.parse(init.body) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply === "throw") throw new Error("network down");
    if (reply === "timeout") { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; }
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers: new Headers(reply.headers ?? {}), json: async () => reply.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const clientWith = (replies: Reply[], extra: { key?: string | undefined; now?: () => number; provider?: JevProvider } = {}) => {
  const f = fakeFetch(replies), sleeps: number[] = [];
  const client = createJevClient({ endpoint: async () => ({ provider: extra.provider ?? JEV_PROVIDERS.typesafe, apiKey: "key" in extra ? extra.key : "k-secret" }), fetch: f.fn, sleep: async (ms) => { sleeps.push(ms); }, ...(extra.now ? { now: extra.now } : {}) });
  return { client, ...f, sleeps };
};

describe("jev client", () => {
  it("posts the state and questions with the bearer key and returns validated answers", async () => {
    const { client, calls } = clientWith([{ status: 200, body: OK_BODY }]);
    const result = await client.call({ state: "payouts failing", questions: QUESTIONS });
    expect(result).toMatchObject({ ok: true, model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 }, attempts: 1 });
    expect(calls[0]).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", auth: "Bearer k-secret", body: { state: "payouts failing", model: "jev-latest", questions: QUESTIONS } });
  });

  it("is disabled without a key and sends nothing", async () => {
    const { client, calls } = clientWith([{ status: 200, body: OK_BODY }], { key: undefined });
    expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("retries once on 429 (honouring retry-after) and on 5xx, then gives up", async () => {
    const first = clientWith([{ status: 429, headers: { "retry-after": "1" } }, { status: 200, body: OK_BODY }]);
    expect(await first.client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: true, attempts: 2 });
    expect(first.sleeps).toEqual([1000]);
    const second = clientWith([{ status: 503 }, { status: 503 }, { status: 200, body: OK_BODY }]);
    expect(await second.client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "error", attempts: 2 });
    expect(second.calls).toHaveLength(2);
  });

  it("does not retry 401 or 422 (our own fault)", async () => {
    for (const status of [401, 422]) {
      const { client, calls } = clientWith([{ status }, { status: 200, body: OK_BODY }]);
      expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "error", attempts: 1 });
      expect(calls).toHaveLength(1);
    }
  });

  it("reports a timeout and a network failure, each after one retry", async () => {
    const slow = clientWith(["timeout", "timeout"]);
    expect(await slow.client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "timeout", attempts: 2 });
    const down = clientWith(["throw", { status: 200, body: OK_BODY }]);
    expect(await down.client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: true, attempts: 2 });
  });

  it("rejects an answer of the wrong shape as invalid", async () => {
    const { client } = clientWith([{ status: 200, body: { model: "m", answers: { urgent: { type: "choice", choice: "a", probabilities: {} } } } }]);
    expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "invalid" });
    const missing = clientWith([{ status: 200, body: { model: "m", answers: {} } }]);
    expect(await missing.client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "invalid" });
  });

  it("spends the run budget one request at a time and stops at zero", async () => {
    const { client, calls } = clientWith([{ status: 200, body: OK_BODY }]);
    const budget = { remaining: 1 };
    expect(await client.call({ state: "x", questions: QUESTIONS }, { budget })).toMatchObject({ ok: true });
    expect(await client.call({ state: "x", questions: QUESTIONS }, { budget })).toMatchObject({ ok: false, status: "budget" });
    expect(calls).toHaveLength(1);
  });

  it("opens the breaker after five failures in a minute and closes it after five minutes", async () => {
    let at = 1_000_000;
    const { client, calls } = clientWith([{ status: 500 }], { now: () => at });
    for (let i = 0; i < 5; i += 1) expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "error" });
    const sent = calls.length;
    expect(client.breaker().open).toBe(true);
    expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "breaker_open" });
    expect(calls).toHaveLength(sent);
    at += 5 * 60_000 + 1;
    expect(client.breaker().open).toBe(false);
  });

  it("names the key of the chosen provider when it is missing", async () => {
    const { client } = clientWith([{ status: 200, body: OK_BODY }], { key: undefined, provider: JEV_PROVIDERS.openlux });
    expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "disabled", error: "no OPENLUX_API_KEY" });
  });
});

describe("jev providers", () => {
  it("defaults to OpenLux and falls back to it for an unknown value", () => {
    expect(resolveJevProvider(undefined).id).toBe("openlux");
    expect(resolveJevProvider("nope").id).toBe("openlux");
    expect(resolveJevProvider("toString").id).toBe("openlux");
    expect(resolveJevProvider("typesafe").id).toBe("typesafe");
  });

  it("sends to OpenLux with its pinned model and its own url", async () => {
    const { client, calls } = clientWith([{ status: 200, body: { ...OK_BODY, model: "jev-1.13.0" } }], { provider: JEV_PROVIDERS.openlux });
    const result = await client.call({ state: "payouts failing", questions: QUESTIONS });
    expect(result).toMatchObject({ ok: true, model: "jev-1.13.0" });
    expect(calls[0]).toMatchObject({ url: "https://api.openlux.ai/v1/systemone", auth: "Bearer k-secret", body: { model: "jev-1.13.0:stable" } });
  });

  it("adds the provider's headroom to every timeout, the caller's own included", async () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return new AbortController().signal; });
    try {
      const official = clientWith([{ status: 200, body: OK_BODY }]);
      await official.client.call({ state: "x", questions: QUESTIONS });
      await official.client.call({ state: "x", questions: QUESTIONS }, { timeoutMs: 8_000 });
      const reseller = clientWith([{ status: 200, body: OK_BODY }], { provider: JEV_PROVIDERS.openlux });
      await reseller.client.call({ state: "x", questions: QUESTIONS });
      await reseller.client.call({ state: "x", questions: QUESTIONS }, { timeoutMs: 8_000 });
    } finally { spy.mockRestore(); }
    expect(timeouts).toEqual([4_000, 8_000, 5_500, 9_500]);
  });

  it("does not retry OpenLux's 500 invalid_request nor count it against the breaker", async () => {
    const bad = { status: 500, body: { error: { message: "question a has unsupported type", type: "new_api_error", code: "invalid_request" } } } as const;
    const { client, calls } = clientWith([bad], { provider: JEV_PROVIDERS.openlux });
    for (let i = 0; i < 6; i += 1) expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: false, status: "error", attempts: 1, error: "http 500 invalid_request" });
    expect(calls).toHaveLength(6);
    expect(client.breaker()).toEqual({ open: false, failures: 0 });
  });

  it("still retries a plain 500 (the service, not the request)", async () => {
    const { client, calls } = clientWith([{ status: 500, body: { error: { code: "internal" } } }, { status: 200, body: OK_BODY }], { provider: JEV_PROVIDERS.openlux });
    expect(await client.call({ state: "x", questions: QUESTIONS })).toMatchObject({ ok: true, attempts: 2 });
    expect(calls).toHaveLength(2);
  });
});
