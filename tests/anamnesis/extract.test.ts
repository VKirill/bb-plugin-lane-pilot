import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostContract } from "../../src/contracts";
import { anamnesisHandler } from "../../src/rooms/anamnesis/host";
import { createHub } from "../../src/rooms/anamnesis/hub";
import { dailyDue, dailyPass, markDailyDone, type DailyDeps } from "../../src/rooms/anamnesis/daily";
import { BUDGET_KEY, SEEN_KEY, createExtractConsumer, extractMessages, madridDay, madridHour, overlap, type ExtractDeps } from "../../src/rooms/anamnesis/extract";
import { matchJudgment, type FragmentDecision, type MatchDecision } from "../../src/rooms/anamnesis/judgment";
import { createOwnerMessageHub, type EventLike, type OwnerMessage, type ThreadLike, type ThreadsPort } from "../../src/rooms/anamnesis/owner-messages";

/** No real Jev, no real load: fixtures for the messages and a fake for the two judgments. */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 10);
const previousDir = process.env.LANE_PILOT_ANAMNESIS_DIR;
let kv: Map<string, unknown>;

const message = (n: number, text: string, daysAgo = 1): OwnerMessage => ({ id: `thr_1:${n}:0`, threadId: "thr_1", projectId: "proj_bb", at: NOW - daysAgo * DAY, text });
const makeHub = () => createHub({
  hostCall: async (hostId, request) => hostContract.anamnesis.output.parse(await anamnesisHandler(hostContract.anamnesis.input.parse({ requestedHostId: hostId, request }))).response,
  listHosts: async () => [{ id: "host_mini", name: "MAC Mini", connected: true }],
  kv: { get: async <T>(key: string) => kv.get(key) as T | undefined, set: async (key, value) => { kv.set(key, value); } },
});

type Fragment = Partial<FragmentDecision>;
/** The judge says what the fixture table says for a text that contains the key, `nothing` otherwise; it records what it was sent. */
function fakes(table: Record<string, Fragment>, relation: (known: string, fragment: string) => MatchDecision["relation"] = () => "new") {
  const sentToJev: string[] = [], matchPairs: Array<{ fragment: string; known: string }> = [];
  const judge: NonNullable<ExtractDeps["judge"]> = async (texts) => {
    sentToJev.push(...texts);
    return texts.map((text) => {
      const hit = Object.entries(table).find(([key]) => text.includes(key));
      return hit ? { kind: "fact", kindP: 0.9, aboutOwner: 0.95, sensitive: 0.05, ...hit[1] } as FragmentDecision : { kind: "nothing", kindP: 0.9, aboutOwner: 0.1, sensitive: 0 };
    });
  };
  const match: NonNullable<ExtractDeps["match"]> = async (pairs) => {
    matchPairs.push(...pairs);
    return pairs.map((pair) => ({ relation: relation(pair.known, pair.fragment), same: 0.9, contradicts: 0.1 }));
  };
  return { judge, match, sentToJev, matchPairs };
}

beforeEach(() => {
  process.env.LANE_PILOT_ANAMNESIS_DIR = join(mkdtempSync(join(tmpdir(), "anamnesis-extract-")), "store");
  kv = new Map();
});
afterEach(() => { if (previousDir === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previousDir; });

const deps = (hub: ReturnType<typeof makeHub>, f: ReturnType<typeof fakes> | null): ExtractDeps => ({ hub, now: () => NOW, ...(f ? { judge: f.judge, match: f.match } : {}) });

describe("what leaves for Jev (A4 keeps the A3 privacy rules)", () => {
  it("sends only masked fragments; short and locally sensitive messages never leave; a second pass does not send them again", async () => {
    const hub = makeHub(), f = fakes({ "отчёты": { kind: "preference" } });
    const batch = [
      message(1, "Всегда пиши отчёты по-русски, мой email me@example.com, коротко и без воды"),
      message(2, "ok"),
      message(3, "у меня болезнь, поэтому по утрам меня не будет на связи, отчёты потом"),
      message(4, "мой ключ API_KEY=supersecretvalue99 нужен для отчёты, запомни это"),
    ];
    const report = await extractMessages(deps(hub, f), batch);
    expect(report).toMatchObject({ considered: 4, tooShort: 1, heldBackSensitive: 1, asked: 2, masked: 1, kept: 2, created: 2, complete: true });
    expect(f.sentToJev.join("\n")).not.toMatch(/me@example\.com|supersecretvalue99|болезнь/);
    expect(f.sentToJev.join("\n")).toContain("[email]");
    const again = await extractMessages(deps(hub, f), batch);
    expect(again).toMatchObject({ alreadySeen: 2, asked: 0 });
    expect(f.sentToJev).toHaveLength(2);
  });

  it("stops at the day's ceiling, the newest first, and tells the pass to keep the window open", async () => {
    const hub = makeHub();
    await hub.setConfig({ maxClassify: 2 });
    const f = fakes({ "правило": { kind: "preference" } });
    const batch = [1, 2, 3].map((n) => message(n, `правило номер ${n}: отчёты по-русски и коротко, спасибо`, 4 - n));
    const report = await extractMessages(deps(hub, f), batch);
    expect(report).toMatchObject({ asked: 2, overCeiling: 1, complete: false });
    expect(f.sentToJev.join("\n")).not.toContain("номер 1");
    expect(kv.get(BUDGET_KEY)).toEqual({ day: madridDay(NOW), used: 2 });
    // The next day the ceiling is new and the cut message is read.
    const tomorrow = await extractMessages({ ...deps(hub, f), now: () => NOW + DAY }, batch);
    expect(tomorrow).toMatchObject({ asked: 1, overCeiling: 0, alreadySeen: 2, complete: true });
  });

  it("without Jev nothing is stored and the window stays open", async () => {
    const hub = makeHub();
    const report = await extractMessages(deps(hub, null), [message(1, "Всегда пиши отчёты по-русски, коротко и без воды, пожалуйста")]);
    expect(report).toMatchObject({ asked: 0, complete: false, note: expect.stringMatching(/Jev is not available/) });
    expect((await hub.ask({ op: "status" })).counts.records).toBe(0);
    expect(kv.get(SEEN_KEY)).toBeUndefined();
  });

  it("a fragment Jev could not judge stays open for the next pass", async () => {
    const hub = makeHub();
    const report = await extractMessages({ hub, now: () => NOW, judge: async (texts) => texts.map(() => null) }, [message(1, "Всегда пиши отчёты по-русски, коротко и без воды, пожалуйста")]);
    expect(report).toMatchObject({ unavailable: 1, complete: false });
    expect(kv.get(SEEN_KEY)).toBeUndefined();
  });
});

describe("dedupe and contradictions", () => {
  const KNOWN = "Всегда пиши отчёты по-русски, коротко и без воды";

  it("a restatement adds evidence to the record it restates and does not make a second one; a candidate that two messages agree on becomes a draft", async () => {
    const hub = makeHub();
    const first = fakes({ "отчёты": { kind: "preference", kindP: 0.6, aboutOwner: 0.7 } });
    await extractMessages(deps(hub, first), [message(1, `${KNOWN}, пожалуйста`, 5)]);
    const [original] = (await hub.ask({ op: "list", kinds: ["preference"] })).records;
    expect(original).toMatchObject({ status: "candidate", evidenceCount: 1 });

    const second = fakes({ "отчёты": { kind: "preference" } }, () => "same");
    const report = await extractMessages(deps(hub, second), [message(2, "Напоминаю: отчёты по-русски, коротко, без воды, это мой стандарт", 1)]);
    expect(report).toMatchObject({ merged: 1, created: 0, contradictions: 0 });
    expect(second.matchPairs).toHaveLength(1);
    const records = (await hub.ask({ op: "list", kinds: ["preference"] })).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: original!.id, status: "draft", evidenceCount: 2, title: original!.title, statement: original!.statement });
  });

  it("a contradiction is a separate candidate that points at the old record, which is not touched", async () => {
    const hub = makeHub();
    const first = fakes({ "отчёты": { kind: "preference" } });
    await extractMessages(deps(hub, first), [message(1, `${KNOWN}, пожалуйста`, 5)]);
    const [original] = (await hub.ask({ op: "list", kinds: ["preference"] })).records;
    await hub.ask({ op: "edit", id: original!.id, patch: { status: "confirmed" }, reason: "owner confirmed" });

    const second = fakes({ "отчёты": { kind: "preference" } }, () => "contradicts");
    const report = await extractMessages(deps(hub, second), [message(2, "С сегодняшнего дня все отчёты пиши по-английски и подробно, это новое правило", 0)]);
    expect(report).toMatchObject({ contradictions: 1, merged: 0 });
    const records = (await hub.ask({ op: "list", kinds: ["preference"] })).records;
    expect(records).toHaveLength(2);
    const kept = records.find((r) => r.id === original!.id)!, challenger = records.find((r) => r.id !== original!.id)!;
    expect(kept).toMatchObject({ status: "confirmed", statement: original!.statement, evidenceCount: original!.evidenceCount + 1 });
    expect(challenger).toMatchObject({ status: "candidate", attributes: { contradicts: [original!.id] } });
  });

  it("two messages in one pass that say the same thing become one record with both as evidence", async () => {
    const hub = makeHub(), f = fakes({ "отчёты": { kind: "preference" } });
    const report = await extractMessages(deps(hub, f), [message(1, `${KNOWN}, пожалуйста`, 3), message(2, `${KNOWN}, пожалуйста!`, 2)]);
    expect(report).toMatchObject({ kept: 2, duplicates: 1, created: 1 });
    const records = (await hub.ask({ op: "list", kinds: ["preference"] })).records;
    expect(records).toHaveLength(1);
    expect(records[0]!.evidenceCount).toBe(2);
  });

  it("a sensitive fragment is stored as a sensitive candidate and its record text is never compared or sent", async () => {
    const hub = makeHub();
    const f = fakes({ "агентство": { kind: "fact", sensitive: 0.7 } }, () => "same");
    await extractMessages(deps(hub, f), [message(1, "Я веду небольшое агентство и делаю сайты для клиентов в Мадриде")]);
    await extractMessages(deps(hub, f), [message(2, "Я веду небольшое агентство и делаю сайты для клиентов в Мадриде уже давно")]);
    expect(f.matchPairs).toHaveLength(0);
    const { records } = await hub.ask({ op: "list", kinds: ["fact"], includeSensitive: true });
    expect(records.every((r) => r.sensitivity === "sensitive" && r.status === "candidate")).toBe(true);
    expect((await hub.ask({ op: "list", kinds: ["fact"] })).records).toHaveLength(0);
  });

  it("a record the owner rejected stays rejected when the same thing is said again", async () => {
    const hub = makeHub();
    const f = fakes({ "отчёты": { kind: "preference" } }, () => "same");
    await extractMessages(deps(hub, f), [message(1, `${KNOWN}, пожалуйста`, 5)]);
    const [original] = (await hub.ask({ op: "list", kinds: ["preference"] })).records;
    await hub.ask({ op: "edit", id: original!.id, patch: { status: "rejected" }, reason: "owner rejected" });
    const before = (await hub.ask({ op: "list", kinds: ["preference"] })).records[0]!.evidenceCount;
    const report = await extractMessages(deps(hub, f), [message(2, "Напоминаю: отчёты по-русски, коротко, без воды, это мой стандарт", 0)]);
    expect(report.stored?.counts).toMatchObject({ blocked: 1 });
    expect((await hub.ask({ op: "list", kinds: ["preference"] })).records[0]).toMatchObject({ status: "rejected", evidenceCount: before });
  });

  it("the match judgment merges a clear restatement, shows a contradiction, and treats anything unclear as new", () => {
    const decide = (same: number, contradicts: number) => matchJudgment.decide({ same: { type: "noul", noul: same, confidence: 1 }, contradicts: { type: "noul", noul: contradicts, confidence: 1 } } as never, { min_same: 0.65, min_contradicts: 0.65 }, { fragment: "", known: "" });
    expect(decide(0.9, 0.1).decision?.relation).toBe("same");
    expect(decide(0.4, 0.9).decision?.relation).toBe("contradicts");
    expect(decide(0.9, 0.9).decision?.relation).toBe("contradicts");
    expect(decide(0.5, 0.5).decision?.relation).toBe("new");
    expect(overlap("отчёты по-русски коротко", "Всегда отчёты пиши по-русски")).toBeGreaterThan(0.5);
  });
});

describe("the consumer and the daily pass", () => {
  const thread = (id: string): ThreadLike => ({ id, projectId: "proj_bb", createdAt: NOW - 300 * DAY, visibility: "visible" });
  let seq = 0;
  const turn = (text: string, daysAgo: number): EventLike => ({ seq: ++seq, type: "client/turn/requested", createdAt: NOW - daysAgo * DAY, data: { initiator: "user", requestId: `r${seq}`, input: [{ type: "text", text }] } });
  const port = (events: Record<string, EventLike[]>): ThreadsPort => {
    const threads = Object.keys(events).map(thread);
    return {
      listThreads: async ({ offset, limit }) => threads.slice(offset, offset + limit),
      listEvents: async ({ threadId, beforeSeq, limit }) => [...(events[threadId] ?? [])].sort((a, b) => b.seq - a.seq).filter((e) => beforeSeq === undefined || e.seq < beforeSeq).slice(0, limit),
    };
  };

  async function pass(events: Record<string, EventLike[]>, f: ReturnType<typeof fakes> | null) {
    const hub = makeHub();
    const extract = deps(hub, f);
    const owner = createOwnerMessageHub();
    const consumer = createExtractConsumer(extract);
    owner.subscribe(consumer);
    const learning = vi.fn();
    owner.subscribe({ name: "learning", handle: learning });
    const root = mkdtempSync(join(tmpdir(), "anamnesis-daily-"));
    const journal = join(root, "BB", "docs", "project-life", "journal");
    mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, "2026-09-20-release.md"), "# First release\n");
    kv.set("anamnesis:config", { roots: [root], authors: ["nobody@example.com"] });
    // The memories of this machine are not a fixture.
    const daily: DailyDeps = { hub, threads: port(events), owner, consumer, now: () => NOW,
      projectNames: async () => new Map([["proj_bb", "BB-сервис"]]), lpRuns: () => [{ id: "lprun_1", projectId: "proj_bb", createdAt: NOW - 3 * DAY }] };
    for (const source of ["claude-memory", "bb-memory"] as const) await hub.ask({ op: "sources", set: { source, enabled: false } });
    return { hub, daily, learning, owner };
  }
  const SAID = () => ({ thr_1: [turn("Всегда пиши отчёты по-русски, коротко и без воды, пожалуйста", 2), turn("запусти тесты ещё раз и покажи результат прогона", 1)] });

  it("does nothing, and sends nothing, while automatic learning is off (the default)", async () => {
    const f = fakes({ "отчёты": { kind: "preference" } });
    const { hub, daily, learning } = await pass(SAID(), f);
    const report = await dailyPass(daily);
    expect(report).toMatchObject({ ran: false, note: expect.stringMatching(/switched off/) });
    expect(f.sentToJev).toHaveLength(0);
    expect(learning).not.toHaveBeenCalled();
    expect((await hub.ask({ op: "status" })).counts.records).toBe(0);
    // The shared consumer ignores live messages too.
    await createExtractConsumer(deps(hub, f)).handle([message(1, "Всегда пиши отчёты по-русски, коротко и без воды, пожалуйста")], { live: true });
    expect(f.sentToJev).toHaveLength(0);
  });

  it("reads the machine's sources, Lane Pilot's runs and the new messages once, shares the messages with the other layer, keeps a receipt and moves its window", async () => {
    const f = fakes({ "отчёты": { kind: "preference" } });
    const { hub, daily, learning } = await pass(SAID(), f);
    await hub.setConfig({ extract: true });
    const report = await dailyPass(daily);
    expect(report).toMatchObject({ ran: true, checkpointAdvanced: true, lpRuns: { runs: 1, projects: 1 }, messages: { total: 2, delivered: ["anamnesis", "learning"], failed: [] } });
    expect(report.messages?.extract).toMatchObject({ asked: 2, kept: 1, created: 1, complete: true });
    expect(report.hostSources.find((s) => s.source === "journal")).toMatchObject({ enabled: true, records: 1 });
    expect(learning).toHaveBeenCalledTimes(1);
    const status = await hub.ask({ op: "status" });
    expect(status.loads[0]).toMatchObject({ mode: "daily" });
    expect(status.sources.find((s) => s.source === "bb-message")?.checkpoint).toBe(NOW);
    const kinds = (await hub.ask({ op: "status" })).counts.byKind;
    expect(kinds).toMatchObject({ preference: 1, project: 1, event: 1 });

    // The next pass reads only what came after the window and sends nothing twice.
    const later = { ...daily, now: () => NOW + DAY };
    const next = await dailyPass(later);
    expect(next.messages).toMatchObject({ window: { from: NOW, to: NOW + DAY }, total: 0 });
    expect(f.sentToJev).toHaveLength(2);
  });

  it("keeps the window open while a fragment is left, so the next pass reads it again", async () => {
    const f = fakes({ "отчёты": { kind: "preference" } });
    const { hub, daily } = await pass(SAID(), f);
    await hub.setConfig({ extract: true, maxClassify: 1 });
    const report = await dailyPass(daily);
    expect(report).toMatchObject({ checkpointAdvanced: false, messages: { extract: { overCeiling: 1, complete: false } } });
    expect((await hub.ask({ op: "status" })).sources.find((s) => s.source === "bb-message")?.checkpoint).toBeNull();
  });

  it("a switched-off source is not read", async () => {
    const f = fakes({});
    const { hub, daily } = await pass(SAID(), f);
    await hub.setConfig({ extract: true });
    await hub.ask({ op: "sources", set: { source: "bb-message", enabled: false } });
    await hub.ask({ op: "sources", set: { source: "git", enabled: false } });
    const report = await dailyPass(daily);
    expect(report.messages).toBeNull();
    expect(report.hostSources.map((s) => s.source)).not.toContain("git");
    expect(f.sentToJev).toHaveLength(0);
  });

  it("is due once a Madrid day, after 04:00", async () => {
    const hub = makeHub();
    const at = (hour: number) => Date.UTC(2026, 9, 8, hour - 2); // Madrid is UTC+2 in October
    expect(madridHour(at(3))).toBe(3);
    expect(await dailyDue(hub, at(3))).toBe(false);
    expect(await dailyDue(hub, at(4))).toBe(true);
    await markDailyDone(hub, at(4));
    expect(await dailyDue(hub, at(9))).toBe(false);
    expect(await dailyDue(hub, at(4) + DAY)).toBe(true);
  });
});
