import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { EMBED_DIM, forgetLockTerms, languageOf, memoryJudgeStats, parseJudgeReply, parseMemorySettings, permutationOf, readJudgeReply, rememberLockTerms, rememberQueryVector, searchMemoryRecords, storeMemoryRecords, storeVectors, wordCandidates, type MemoryRecord } from "../packages/memory-core/src";
import { judgeFound, openLuxJudge, setMemoryJudge, translateForLock, type MemoryJudge } from "../src/rooms/memory/server/memory-judge";
import { explicitMemorySearch } from "../src/rooms/memory/server/memory-search";
import { pmMemoryContext } from "../src/rooms/memory/server/memory-mix";
import { openDatabase } from "../src/rooms/plugin-db";

const record = (id: string, content: string): MemoryRecord => ({ id, content, kind: "note", concepts: [], projectId: "P", personalBot: "", sourceSha256: "", createdAt: 1 });
const limits = { sourceSha256: "d".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const axis = (i: number, j = i, mix = 0) => { const v = new Float32Array(EMBED_DIM); v[i] = 1 - mix; v[j] += mix; return v; };
const fresh = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const put = (db: ReturnType<typeof fresh>, content: string, kind: "note" | "core" = "note") => storeMemoryRecords(db, { projectId: "P", personalBot: "", ...limits, entries: [{ kind, content, concepts: kind === "core" ? ["convention"] : [] }] }).insertedIds[0]!;

afterEach(() => { setMemoryJudge(null); forgetLockTerms(); });

describe("settings of the recipe", () => {
  it("default to today's behaviour and read the three forks and the pin", () => {
    expect(parseMemorySettings({})).toMatchObject({ vectorMode: "all", doorLock: "off", judgeMode: "filter", pinned: false });
    expect(parseMemorySettings({ "memory.vector_mode": "bridge", "memory.door_lock": "translated", "memory.judge.mode": "rerank", "memory.pinned": "on" })).toMatchObject({ vectorMode: "bridge", doorLock: "translated", judgeMode: "rerank", pinned: true });
    expect(parseMemorySettings({ "memory.vector_mode": "nonsense", "memory.door_lock": "x", "memory.judge.mode": "y" })).toMatchObject({ vectorMode: "all", doorLock: "off", judgeMode: "filter" });
  });
});

describe("M1: the word layer as a candidate generator", () => {
  it("finds an exact identifier first, with a BM25 score", () => {
    const db = fresh();
    const hit = put(db, "The export job writes ZX-7741-manifest.csv at 02:10 and uploads it.");
    put(db, "The import job reads a feed at 03:00 and writes a report.");
    put(db, "Gate 4 handles the evening batches.");
    const found = wordCandidates(db, "P", "where is the ZX-7741 manifest uploaded", 10);
    expect(found[0]!.record.id).toBe(hit);
    expect(found[0]!.score).toBeGreaterThan(0);
  });
});

describe("M2: language and the vector bridge", () => {
  it("tells Russian, English and neither", () => {
    expect(languageOf("Почему упал билд?")).toBe("ru");
    expect(languageOf("Why did the build fail?")).toBe("en");
    expect(languageOf("12345 ::")).toBe("none");
    expect(languageOf("Why did the сборка fail on main?")).toBe("en");
  });

  it("the bridge adds only notes in another language than the question; `all` ranks every note", () => {
    const db = fresh();
    const english = put(db, "The webhook signing secret rotates every month.");
    const russianNote = put(db, "Секрет подписи вебхука меняется каждый месяц.");
    storeVectors(db, [{ id: english, projectId: "P", content: "x", vector: axis(0, 1, 0.1) }, { id: russianNote, projectId: "P", content: "x", vector: axis(0, 1, 0.05) }]);
    rememberQueryVector("как часто меняется секрет вебхука", axis(0));
    const ids = (mode: "bridge" | "all") => searchMemoryRecords(db, "P", "как часто меняется секрет вебхука", 10, "auto", "subagent", "", { vectorMode: mode }).map((r) => r.id);
    // The Russian note shares words with the question: the word layer has it in both modes. The English one is the bridge's.
    expect(ids("bridge")).toContain(english);
    expect(ids("bridge")).toContain(russianNote);
    // an English question: the vectors add nothing across (the English notes are not another language)
    rememberQueryVector("rotate secret", axis(0));
    const sameLanguage = searchMemoryRecords(db, "P", "rotate secret", 10, "auto", "subagent", "", { vectorMode: "bridge" }).map((r) => r.id);
    expect(sameLanguage).toContain(english);
    expect(sameLanguage).toContain(russianNote);
  });
});

describe("M3: the door lock", () => {
  const shelf = () => {
    const db = fresh();
    const note = put(db, "The ferry booking connector gives up a request after fourteen seconds and retries twice.");
    for (let i = 0; i < 20; i++) put(db, `Depot log ${i}: cargo moved through gate ${i} in batch ${i}.`);
    return { db, note };
  };
  it("literal: a question with no word of the notes gets an empty list even with a vector that matches", () => {
    const { db, note } = shelf();
    storeVectors(db, [{ id: note, projectId: "P", content: "x", vector: axis(0) }]);
    const q = "через сколько секунд обрывается запрос коннектора";
    rememberQueryVector(q, axis(0));
    expect(searchMemoryRecords(db, "P", q, 10, "auto", "subagent", "", { vectorMode: "all" }).map((r) => r.id)).toContain(note);
    expect(searchMemoryRecords(db, "P", q, 10, "auto", "subagent", "", { vectorMode: "bridge", doorLock: "literal" })).toEqual([]);
    expect(searchMemoryRecords(db, "P", q, 10, "auto", "subagent", "", { vectorMode: "bridge", doorLock: "translated" })).toEqual([]);
  });
  it("literal opens on a rare word, stays shut on a word everything has", () => {
    const { db, note } = shelf();
    expect(searchMemoryRecords(db, "P", "ferry connector retries", 10, "auto", "subagent", "", { doorLock: "literal" }).map((r) => r.id)).toContain(note);
    expect(searchMemoryRecords(db, "P", "cargo", 10, "auto", "subagent", "", { doorLock: "literal" })).toEqual([]);
    expect(searchMemoryRecords(db, "P", "cargo", 10, "auto", "subagent", "", { doorLock: "off" }).length).toBeGreaterThan(0);
  });
  it("translated: the keywords open the door the Russian words cannot", () => {
    const { db, note } = shelf();
    const q = "через сколько секунд обрывается запрос коннектора";
    rememberLockTerms(q, ["ferry", "booking", "connector", "request"]);
    expect(searchMemoryRecords(db, "P", q, 10, "auto", "subagent", "", { vectorMode: "bridge", doorLock: "translated" }).map((r) => r.id)).toContain(note);
  });
  it("the translation is one call of the judge route, cached per question; a failed call leaves the literal lock", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      expect(JSON.parse(String(init.body)).messages[1].content).toContain("Question:");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ferry, booking, connector." } }], usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const judge = openLuxJudge(async () => "k", fetchImpl);
    const memory = parseMemorySettings({ "memory.door_lock": "translated", "memory.judge.model": "gemini-3.8-flash" });
    setMemoryJudge(judge);
    expect(await translateForLock("паромы?", memory)).toEqual(["ferry", "booking", "connector"]);
    expect(await translateForLock("паромы?", memory)).toEqual(["ferry", "booking", "connector"]);
    expect(calls).toBe(1);
    const broken = openLuxJudge(async () => "k", (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
    setMemoryJudge(broken);
    expect(await translateForLock("другой вопрос", memory)).toBeNull();
    // no translation, no terms: the lock is the literal one
    const { db } = shelf();
    expect(searchMemoryRecords(db, "P", "другой вопрос", 10, "auto", "subagent", "", { doorLock: "translated" })).toEqual([]);
    // not `translated`: no call at all
    expect(await translateForLock("паромы?", parseMemorySettings({}))).toBeNull();
  });
});

describe("M5: no embeddings, the word layer answers", () => {
  it("search with no question vector (embedder unavailable) finds the note by words in every mode", async () => {
    const db = fresh();
    const note = put(db, "The invoice exporter retries three times with a pause of ten seconds.");
    put(db, "Gate four handles the evening batches.");
    const q = "how many times does the invoice exporter retry";
    for (const vectorMode of ["all", "bridge"] as const) {
      const found = searchMemoryRecords(db, "P", q, 10, "auto", "subagent", "", { vectorMode });
      expect(found[0]!.id, vectorMode).toBe(note);
      const out = await explicitMemorySearch(db, { projectId: "P", query: q, limit: 5, memory: parseMemorySettings({ "memory.vector_mode": vectorMode }) });
      expect(out.records.map((r) => r.id), vectorMode).toContain(note);
    }
  });
});

describe("M8: the reply parser", () => {
  const forms: Array<[string, number[]]> = [
    ["[2, 1, 3]", [2, 1, 3]],
    ['["2","1","3"]', [2, 1, 3]],
    ['["[2]","[1]","[3]"]', [2, 1, 3]],
    ["2, 1, 3", [2, 1, 3]],
    ["2 1 3", [2, 1, 3]],
    ["```json\n[\n  2,\n  1,\n  3\n]\n```", [2, 1, 3]],
    ["1. note 2\n2. note 1\n3. note 3", [2, 1, 3]],
    ["Note 2 is the most useful, then note 1, then 3.", [2, 1, 3]],
    ["I compared them one by one and the second is the best.\nOrder: 2, 1, 3", [2, 1, 3]],
  ];
  it.each(forms)("reads %j", (reply, expected) => { expect(readJudgeReply(reply, 3)!.numbers).toEqual(expected); });
  it("counts what it could not use and refuses what is no answer", () => {
    expect(readJudgeReply("2, 9, 1", 3)).toEqual({ numbers: [2, 1], dropped: 1, none: false });
    expect(readJudgeReply("none", 3)).toMatchObject({ numbers: [], none: true });
    expect(readJudgeReply("I cannot say.", 3)).toBeNull();
    expect(parseJudgeReply("[1]", 3)).toEqual([1]);
  });
  it("a permutation is completed with the missing numbers in the previous order, and no reply is the previous order", () => {
    expect(permutationOf([3, 1], 4)).toEqual([3, 1, 2, 4]);
    expect(permutationOf([3, 3, 9, 1], 4)).toEqual([3, 1, 2, 4]);
    expect(permutationOf(null, 3)).toEqual([1, 2, 3]);
  });
});

/** A stub endpoint that answers every call with the next reply (a string, a status, or "timeout"). */
function endpoint(replies: Array<string | number>) {
  const prompts: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }>; tools?: unknown };
    prompts.push(body.messages[1]!.content);
    expect(body.tools).toBeUndefined();
    const next = replies[prompts.length - 1] ?? 500;
    if (next === "timeout") throw Object.assign(new Error("t"), { name: "TimeoutError" });
    if (typeof next === "number") return new Response("{}", { status: next });
    return new Response(JSON.stringify({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, prompts };
}
const notes = [record("a", "alpha port is 4000 (src/alpha/port.ts)"), record("b", "beta uses sqlite"), record("c", "gamma has a cron"), record("d", "delta is a queue")];
const rerankSettings = { model: "gemini-3.8-flash", fallbackModel: "", timeoutMs: 5000, mode: "rerank" as const };

describe("M7: the reranker", () => {
  it("shows every note by number and text only, no ids, in the order given, and returns the full new order", async () => {
    const http = endpoint(["4, 2, 1, 3"]);
    const out = await openLuxJudge(async () => "k", http.fetchImpl)({ query: "which queue?", candidates: notes, settings: rerankSettings });
    expect(out.chosen!.map((r) => r.id)).toEqual(["d", "b", "a", "c"]);
    expect(out.receipt).toMatchObject({ mode: "rerank", chosen: ["d", "b", "a", "c"] });
    const prompt = http.prompts[0]!;
    expect(prompt).toContain("[1]\nalpha port is 4000");
    expect(prompt.indexOf("[4]\ndelta")).toBeGreaterThan(prompt.indexOf("[1]\nalpha"));
    for (const id of ["a", "b", "c", "d"]) expect(prompt).not.toContain(`id=${id}`);
    expect(prompt).toMatch(/do not answer none/i);
  });
  it("appends the numbers the model left out in the previous order", async () => {
    const out = await openLuxJudge(async () => "k", endpoint(["3"]).fetchImpl)({ query: "q", candidates: notes, settings: rerankSettings });
    expect(out.chosen!.map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
  });
  it("never returns fewer notes: an answer of none, garbage, a timeout and an error leave the previous order (chosen null, the caller keeps it)", async () => {
    for (const reply of ["none", "I do not know", "timeout", 500] as const) {
      const out = await openLuxJudge(async () => "k", endpoint([reply]).fetchImpl)({ query: "q", candidates: notes, settings: rerankSettings });
      expect(out.chosen, String(reply)).toBeNull();
      expect(out.receipt.fallback, String(reply)).toBeDefined();
    }
  });
  it("judgeFound in rerank mode returns every note, in the judge's order for the candidates; a failure returns all in the previous order; pinned stay first", async () => {
    const db = fresh();
    const ids = ["one", "two", "three", "four", "five", "six", "seven"].map((word) => put(db, `${word} fact about the pipeline`));
    const core = put(db, "Rule: keep the audit log", "core");
    const found = ids.map((id, i) => ({ ...record(id, `${i}`), projectId: "P" }));
    const memory = parseMemorySettings({ "memory.judge.mode": "rerank", "memory.judge.candidates": 5 });
    setMemoryJudge(async ({ candidates }) => ({ chosen: [...candidates].reverse(), receipt: { model: "m", candidates: candidates.map((r) => r.id), chosen: [...candidates].reverse().map((r) => r.id), latencyMs: 1, tokensIn: 1, tokensOut: 1, mode: "rerank" } }));
    const out = await judgeFound(db, { projectId: "P", query: "pipeline?", found, memory, surface: "search", pinned: new Set([core]) });
    expect(out.records).toHaveLength(found.length);
    expect(out.records.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0], ids[5], ids[6]]);
    const withPin = await judgeFound(db, { projectId: "P", query: "pipeline?", found: [record(core, "Rule"), ...found], memory, surface: "search", pinned: new Set([core]) });
    expect(withPin.records[0]!.id).toBe(core);
    expect(withPin.records).toHaveLength(found.length + 1);
    setMemoryJudge(async () => { throw new Error("down"); });
    const failed = await judgeFound(db, { projectId: "P", query: "pipeline?", found, memory, surface: "search" });
    expect(failed.records.map((r) => r.id)).toEqual(ids);
    setMemoryJudge(async ({ candidates }) => ({ chosen: null, receipt: { model: "m", candidates: candidates.map((r) => r.id), chosen: [], latencyMs: 1, tokensIn: 0, tokensOut: 0, fallback: "timeout", mode: "rerank" } }));
    expect((await judgeFound(db, { projectId: "P", query: "pipeline?", found, memory, surface: "search" })).records.map((r) => r.id)).toEqual(ids);
  });
  it("filter mode (the default) still drops what the judge does not name", async () => {
    const db = fresh();
    const found = [record("a", "x"), record("b", "y"), record("c", "z")];
    setMemoryJudge((async ({ candidates }: { candidates: readonly MemoryRecord[] }) => ({ chosen: [candidates[1]!], receipt: { model: "m", candidates: [], chosen: [], latencyMs: 1, tokensIn: 0, tokensOut: 0 } })) as MemoryJudge);
    expect((await judgeFound(db, { projectId: "P", query: "q", found, memory: parseMemorySettings({}), surface: "search" })).records.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("M8: unparsed replies are counted", () => {
  it("a receipt carries the count and judge-stats sums the calls that lost answers", async () => {
    const db = fresh();
    const ids = ["a1", "b1", "c1"].map((word) => put(db, `${word} fact about the pipeline`));
    const found = ids.map((id) => record(id, "x"));
    const run = async (reply: string, mode: "filter" | "rerank") => {
      setMemoryJudge(openLuxJudge(async () => "k", endpoint([reply]).fetchImpl));
      await judgeFound(db, { projectId: "P", query: `q ${reply} ${mode}`, found, memory: parseMemorySettings({ "memory.judge.mode": mode, "memory.judge.fallback_model": "none-such-model" }), surface: "search" });
    };
    await run("1, 2", "filter");
    await run("1, 7", "filter");
    await run("shrug", "filter");
    await run("3, 1, 2", "rerank");
    const stats = memoryJudgeStats(db, 0, "P");
    expect(stats).toMatchObject({ calls: 4, unparsed: 2, rerank: 1 });
  });
});

describe("M6: pinned records", () => {
  it("a pinned core rule arrives in the PM context with no word in common with the question, and not when `memory.pinned` is off", () => {
    const db = fresh();
    put(db, "The invoice exporter retries three times with a pause of ten seconds.");
    const rule = put(db, "Rule: a customer parcel record is never deleted; it is archived instead.", "core");
    const q = "how many times does the invoice exporter retry";
    const on = pmMemoryContext(db, "P", parseMemorySettings({ "memory.pinned": true }), q, []);
    expect(on.records.map((r) => r.id)).toContain(rule);
    const off = pmMemoryContext(db, "P", parseMemorySettings({}), q, []);
    expect(off.records.map((r) => r.id)).not.toContain(rule);
    // behind a closed door
    const locked = pmMemoryContext(db, "P", parseMemorySettings({ "memory.pinned": true, "memory.door_lock": "literal" }), "which font do headings use", []);
    expect(locked.records.map((r) => r.id)).toEqual([rule]);
  });
});
