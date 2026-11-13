import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { EMBED_DIM, JUDGE_DEFAULTS, judgeUserPrompt, maskSecretsForJudge, memoryJudgeStats, parseJudgeReply, parseMemorySettings, rememberQueryVector, shuffledBy, storeMemoryRecords, storeVectors, listMemoryReceipts, type MemoryRecord } from "../packages/memory-core/src";
import { judgeFound, judgeRoutes, openLuxJudge, setMemoryJudge } from "../src/rooms/memory/server/memory-judge";
import { judgeWriterMemory, mixWriterMemory, pmMemoryContext, pmMemoryContextJudged } from "../src/rooms/memory/server/memory-mix";
import { openDatabase } from "../src/rooms/plugin-db";

const record = (id: string, content: string): MemoryRecord => ({ id, content, kind: "note", concepts: [], projectId: "P", personalBot: "", sourceSha256: "", createdAt: 1 });
const settings = { model: "gemini-3.8-flash", fallbackModel: "gpt-6-luna", timeoutMs: 12_000 };
const candidates = [record("a", "alpha port is 4000"), record("b", "beta uses sqlite"), record("c", "gamma has a cron"), record("d", "delta is a queue")];

type Call = { model: string; body: { model: string; messages: Array<{ role: string; content: string }>; temperature: number; max_tokens: number }; auth: string | null };
/** A stub chat-completions endpoint: each reply is a string (the model's text), a number (an HTTP status), or "timeout". */
function stub(replies: Array<string | number>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.openlux.ai/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    calls.push({ model: body.model, body, auth: (init.headers as Record<string, string>).Authorization ?? null });
    const next = replies[calls.length - 1] ?? 500;
    if (next === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (typeof next === "number") return new Response("{}", { status: next });
    return new Response(JSON.stringify({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 100, completion_tokens: 7 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
/** The number the note holding `text` got in the shuffled prompt. */
const noteNumberOf = (prompt: string, text: string): number => {
  const before = prompt.slice(0, prompt.indexOf(text));
  const marks = [...before.matchAll(/\[(\d+)\]\n/g)];
  return Number(marks.at(-1)![1]);
};

describe("the judge's reply", () => {
  it("reads numbers, none, a last line after thinking aloud, and refuses the rest", () => {
    expect(parseJudgeReply("2, 4", 4)).toEqual([2, 4]);
    expect(parseJudgeReply("none", 4)).toEqual([]);
    expect(parseJudgeReply("9", 4)).toBeNull();
    expect(parseJudgeReply("", 4)).toBeNull();
    expect(parseJudgeReply("I looked at all four notes and note 1 is about ports but the question asks about queues.\n3", 4)).toEqual([3]);
    expect(parseJudgeReply("Notes 1 and 2 talk about it at length, but only the third one has the fact the question needs.\nnone", 4)).toEqual([]);
  });

  it("masks secret-looking spans and keeps the key and the rest of the note", () => {
    const text = "deploy with sk-abcdefghijklmnopqrstuvwx and ak_1234567890abcdef, ghp_abcdefghijklmnopqrstuv, AIzaSyA1234567890abcdefghijk; hash 0123456789abcdef0123456789abcdef01; password=hunter22 path src/rooms/memory/server/memory-judge.ts";
    const masked = maskSecretsForJudge(text);
    for (const secret of ["sk-abcdef", "ak_12345", "ghp_abcdef", "AIzaSyA1", "0123456789abcdef0123", "hunter22"]) expect(masked).not.toContain(secret);
    expect(masked).toContain("password=[REDACTED]");
    expect(masked).toContain("src/rooms/memory/server/memory-judge.ts");
    expect(masked.match(/\[REDACTED\]/g)!.length).toBeGreaterThanOrEqual(6);
    expect(maskSecretsForJudge("QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9wcXJz")).toBe("[REDACTED]");
    expect(judgeUserPrompt("q?", [record("x", "token sk-abcdefghijklmnopqrstuvwx")])).toContain("[1]\ntoken [REDACTED]");
  });

  it("shuffles by the question, the same way every time", () => {
    expect(shuffledBy([1, 2, 3, 4, 5, 6], "same")).toEqual(shuffledBy([1, 2, 3, 4, 5, 6], "same"));
    expect([...shuffledBy([1, 2, 3, 4, 5, 6], "same")].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("the judge call", () => {
  it("returns the chosen notes in the order of the candidates and sends the verbatim prompt with masked secrets", async () => {
    const withSecret = [record("a", "alpha port is 4000 with sk-abcdefghijklmnopqrstuvwx"), ...candidates.slice(1)];
    const calls: Call[] = [];
    // The model answers with the numbers of notes d and b as they were shown.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ model: body.model, body, auth: (init.headers as Record<string, string>).Authorization ?? null });
      const prompt = body.messages[1].content as string;
      return new Response(JSON.stringify({ choices: [{ message: { content: `${noteNumberOf(prompt, "delta is")}, ${noteNumberOf(prompt, "beta uses")}` } }], usage: { prompt_tokens: 120, completion_tokens: 5 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await openLuxJudge(async () => "key-1", fetchImpl)({ query: "which queue?", candidates: withSecret, settings });
    expect(out.chosen!.map((r) => r.id)).toEqual(["b", "d"]);
    expect(out.receipt).toMatchObject({ model: "gemini-3.8-flash", candidates: ["a", "b", "c", "d"], chosen: ["b", "d"], tokensIn: 120, tokensOut: 5 });
    expect(out.receipt.fallback).toBeUndefined();
    const [call] = calls;
    expect(call!.auth).toBe("Bearer key-1");
    expect(call!.body.temperature).toBe(0);
    expect(call!.body.max_tokens).toBe(1500);
    expect(call!.body.messages[0]!.content).toBe("You check whether a project's memory notes answer a question. Be strict: a note answers only if it states the specific fact the question asks for; a note on a merely related topic does not.");
    const user = call!.body.messages[1]!.content;
    expect(user.startsWith("Question: which queue?\n\nNotes:\n\n[1]\n")).toBe(true);
    expect(user.endsWith("Which of these notes contain facts that help answer the question? Reply with only the numbers of ALL notes that help, separated by commas, or the word none if no note helps.")).toBe(true);
    expect(user).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(user).toContain("[REDACTED]");
  });

  it("router9/ names go to 9router with its key; a 403 there asks OpenLux at once and skips 9router for two minutes", async () => {
    let clock = 1_000;
    const calls: Array<{ url: string; model: string; auth: string | null }> = [];
    const replies: Array<string | number> = [403, "none", "1", "1"];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, model: body.model, auth: (init.headers as Record<string, string>).Authorization ?? null });
      const next = replies[calls.length - 1] ?? 500;
      if (typeof next === "number") return new Response("{}", { status: next });
      return new Response(JSON.stringify({ choices: [{ message: { content: next } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const routes = judgeRoutes(async () => "lux-key", async () => "r9-key");
    const judge = openLuxJudge(async () => "lux-key", fetchImpl, () => clock, undefined, routes);
    const routed = { model: "router9/ag/gemini-3.8-flash-low", fallbackModel: "gemini-3.8-flash", timeoutMs: 12_000 };
    const first = await judge({ query: "q1", candidates, settings: routed });
    expect(calls.map((call) => [call.url, call.model, call.auth])).toEqual([
      ["https://9router.vechkasov.pro/v1/chat/completions", "ag/gemini-3.8-flash-low", "Bearer r9-key"],
      ["https://api.openlux.ai/v1/chat/completions", "gemini-3.8-flash", "Bearer lux-key"],
    ]);
    expect(first.chosen).toEqual([]);
    expect(first.receipt.retriedWith).toBe("gemini-3.8-flash");
    // within the lock: straight to OpenLux
    clock += 60_000;
    await judge({ query: "q2", candidates, settings: routed });
    expect(calls[2]!.url).toBe("https://api.openlux.ai/v1/chat/completions");
    // after the lock: 9router again
    clock += 2 * 60_000;
    await judge({ query: "q3", candidates, settings: routed });
    expect(calls[3]!.url).toBe("https://9router.vechkasov.pro/v1/chat/completions");
  });

  it("a hang on 9router is not the end: OpenLux gets a fresh window", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("9router")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "2" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const judge = openLuxJudge(async () => "k", fetchImpl, Date.now, undefined, judgeRoutes(async () => "k", async () => "k"));
    const out = await judge({ query: "q", candidates, settings: { model: "router9/ag/gemini-3.8-flash-low", fallbackModel: "gemini-3.8-flash", timeoutMs: 12_000 } });
    expect(calls).toHaveLength(2);
    expect(out.chosen).toHaveLength(1);
    expect(out.receipt.fallback).toBeUndefined();
  });

  it("none is an answer: no notes, no fallback", async () => {
    const http = stub(["none"]);
    const out = await openLuxJudge(async () => "k", http.fetchImpl)({ query: "q", candidates, settings });
    expect(out.chosen).toEqual([]);
    expect(out.receipt.fallback).toBeUndefined();
  });

  it("a timeout falls back at once, without a second model", async () => {
    const http = stub(["timeout", "1"]);
    const out = await openLuxJudge(async () => "k", http.fetchImpl)({ query: "q", candidates, settings });
    expect(out.chosen).toBeNull();
    expect(out.receipt.fallback).toBe("timeout");
    expect(http.calls).toHaveLength(1);
  });

  it("an HTTP error retries once with the fallback model; a second failure falls back", async () => {
    const ok = stub([503, "none"]);
    const first = await openLuxJudge(async () => "k", ok.fetchImpl)({ query: "q", candidates, settings });
    expect(ok.calls.map((call) => call.model)).toEqual(["gemini-3.8-flash", "gpt-6-luna"]);
    expect(first.chosen).toEqual([]);
    expect(first.receipt.retriedWith).toBe("gpt-6-luna");
    const bad = stub([500, 500]);
    const second = await openLuxJudge(async () => "k", bad.fetchImpl)({ query: "q", candidates, settings });
    expect(second.chosen).toBeNull();
    expect(second.receipt.fallback).toBe("retry_failed");
    expect(bad.calls).toHaveLength(2);
  });

  it("an unreadable reply and a missing key fall back", async () => {
    expect((await openLuxJudge(async () => "k", stub(["I cannot tell"]).fetchImpl)({ query: "q", candidates, settings })).receipt.fallback).toBe("unparsed");
    const http = stub(["1"]);
    expect((await openLuxJudge(async () => undefined, http.fetchImpl)({ query: "q", candidates, settings })).receipt.fallback).toBe("no_key");
    expect(http.calls).toHaveLength(0);
  });

  it("caches a clean answer for ten minutes by question and candidates", async () => {
    let clock = 1_000;
    const http = stub(["none", "none", "none"]);
    const judge = openLuxJudge(async () => "k", http.fetchImpl, () => clock);
    await judge({ query: "q", candidates, settings });
    clock += 9 * 60_000;
    const again = await judge({ query: "q", candidates: [...candidates].reverse(), settings });
    expect(again.receipt.cached).toBe(true);
    expect(http.calls).toHaveLength(1);
    await judge({ query: "other", candidates, settings });
    clock += 2 * 60_000;
    await judge({ query: "q", candidates, settings });
    expect(http.calls).toHaveLength(3);
  });
});

const limits = { sourceSha256: "d".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const axis = (i: number, j = i, mix = 0) => { const v = new Float32Array(EMBED_DIM); v[i] = 1 - mix; v[j] += mix; return v; };

function plant(count = 8, kind: "note" | "core" = "note") {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  const ids = Array.from({ length: count }, (_, i) => storeMemoryRecords(db, { projectId: "P", personalBot: "", ...limits, entries: [{ kind, content: `note ${i}: queue fact number ${i} for the pipeline`, concepts: [] }] }).insertedIds[0]!);
  // Cosines fall as the mix grows; the last records sit under the 0.50 pre-filter.
  storeVectors(db, ids.map((id, i) => ({ id, projectId: "P", content: "x", vector: axis(0, 1, i === count - 1 ? 0.9 : 0.05 + i * 0.03) })));
  return { db, ids };
}
const memory = parseMemorySettings({});
afterEach(() => setMemoryJudge(null));

describe("judging a search", () => {
  it("keeps the notes the judge names, writes a receipt, and shows no warning line", async () => {
    const { db, ids } = plant();
    rememberQueryVector("queue facts?", axis(0));
    setMemoryJudge(async ({ candidates: seen }) => ({ chosen: [seen[1]!], receipt: { model: "gemini-3.8-flash", candidates: seen.map((r) => r.id), chosen: [seen[1]!.id], latencyMs: 41, tokensIn: 300, tokensOut: 9 } }));
    const packed = await pmMemoryContextJudged(db, "P", memory, "queue facts?", []);
    expect(packed.records).toHaveLength(1);
    expect(ids).toContain(packed.records[0]!.id);
    expect(packed.text).not.toMatch(/no confident answer|look related/i);
    const rows = db.prepare("SELECT role, judge_json FROM lane_pilot_memory_receipt WHERE judge_json IS NOT NULL").all() as Array<{ role: string; judge_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("judge:pm_tool");
    expect(JSON.parse(rows[0]!.judge_json)).toMatchObject({ surface: "pm_tool", model: "gemini-3.8-flash", chosen: [packed.records[0]!.id], latencyMs: 41, tokensIn: 300, tokensOut: 9 });
    expect(memoryJudgeStats(db, 0, "P")).toMatchObject({ calls: 1, none: 0, tokensIn: 300, tokensOut: 9, bySurface: { pm_tool: 1 } });
    expect(listMemoryReceipts(db, "P", 5).some((r) => r.role === "judge:pm_tool")).toBe(true);
  });

  it("none from the judge is an empty list, and a cosine under 0.50 never reaches the judge", async () => {
    const { db, ids } = plant();
    rememberQueryVector("queue facts?", axis(0));
    let seen: string[] = [];
    setMemoryJudge(async ({ candidates: shown }) => { seen = shown.map((r) => r.id); return { chosen: [], receipt: { model: "m", candidates: seen, chosen: [], latencyMs: 1, tokensIn: 1, tokensOut: 1 } }; });
    const packed = await pmMemoryContextJudged(db, "P", memory, "queue facts?", []);
    expect(packed.nothingRelevant).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(ids.at(-1));
    expect(memoryJudgeStats(db, 0)).toMatchObject({ calls: 1, none: 1 });
  });

  it("a failing judge hands back the first five by cosine with no warning, and says why in the receipt", async () => {
    const { db } = plant(10);
    rememberQueryVector("queue facts?", axis(0));
    setMemoryJudge(async ({ candidates: shown }) => ({ chosen: null, receipt: { model: "m", candidates: shown.map((r) => r.id), chosen: [], latencyMs: 12_000, tokensIn: 0, tokensOut: 0, fallback: "timeout" } }));
    const base = pmMemoryContext(db, "P", memory, "queue facts?", []).records;
    expect(base.length).toBeGreaterThan(5);
    const found = await judgeFound(db, { projectId: "P", query: "queue facts?", found: base, memory, surface: "search" });
    expect(found.records.map((r) => r.id)).toEqual(base.slice(0, 5).map((r) => r.id));
    expect(memoryJudgeStats(db, 0).fallbacks).toEqual({ timeout: 1 });
  });

  it("memory.judge.enabled off, or no judge mounted, leaves the list as it came", async () => {
    const { db } = plant();
    rememberQueryVector("queue facts?", axis(0));
    let asked = 0;
    setMemoryJudge(async () => { asked++; throw new Error("must not be asked"); });
    const base = pmMemoryContext(db, "P", memory, "queue facts?", []).records;
    const off = await judgeFound(db, { projectId: "P", query: "queue facts?", found: base, memory: parseMemorySettings({ "memory.judge.enabled": "false" }), surface: "search" });
    expect(off.records.map((r) => r.id)).toEqual(base.map((r) => r.id));
    expect(asked).toBe(0);
    setMemoryJudge(null);
    expect((await judgeFound(db, { projectId: "P", query: "queue facts?", found: base, memory, surface: "search" })).records).toHaveLength(base.length);
  });

  it("the per-turn context never asks the judge", () => {
    const { db } = plant();
    rememberQueryVector("queue facts?", axis(0));
    setMemoryJudge(async () => { throw new Error("the PM's automatic context must not call the judge"); });
    expect(pmMemoryContext(db, "P", memory, "queue facts?", []).records.length).toBeGreaterThan(0);
  });

  it("the writer's brief asks the judge; notes outside its choice are left out", async () => {
    const { db } = plant(8, "core");
    rememberQueryVector("queue facts pipeline", axis(0));
    let chosenId = "";
    setMemoryJudge(async ({ candidates: shown }) => { chosenId = shown[2]!.id; return { chosen: [shown[2]!], receipt: { model: "m", candidates: shown.map((r) => r.id), chosen: [chosenId], latencyMs: 5, tokensIn: 1, tokensOut: 1 } }; });
    const input = { projectId: "P", query: "queue facts pipeline", task: { owns_paths: [], read_first: [] }, searchEngine: "auto" as const, personalBot: "", ruleMemoryIds: new Set<string>() };
    const allowed = await judgeWriterMemory(db, input, memory);
    expect([...allowed!]).toEqual([chosenId]);
    expect(mixWriterMemory(db, { ...input, allowedIds: allowed }).ids).toEqual([chosenId]);
    expect(mixWriterMemory(db, input).ids.length).toBeGreaterThan(1);
    expect(memoryJudgeStats(db, 0).bySurface).toEqual({ writer: 1 });
  });
});

describe("defaults", () => {
  it("the five settings read their defaults and a bad model id does not take memory down", () => {
    expect(parseMemorySettings({})).toMatchObject({ judgeEnabled: true, judgeModel: JUDGE_DEFAULTS.model, judgeFallbackModel: JUDGE_DEFAULTS.fallbackModel, judgeTimeoutMs: 12_000, judgeCandidates: 12 });
    expect(parseMemorySettings({ "memory.judge.model": "has spaces", "memory.judge.candidates": 7 })).toMatchObject({ judgeModel: JUDGE_DEFAULTS.model, judgeCandidates: 7 });
  });
});
