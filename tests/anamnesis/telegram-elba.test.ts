import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSources } from "../../src/rooms/anamnesis/collect";
import { DEFAULT_SOURCES } from "../../src/rooms/anamnesis/model";
import { openStore, type Store } from "../../src/rooms/anamnesis/store";
import { scanElba } from "../../src/rooms/anamnesis/sources/elba";
import { channelName, parseHistory, scanTelegram, tgPath } from "../../src/rooms/anamnesis/sources/telegram";

/** Fixtures only: no Telegram session, no Elba cabinet, no network. */
const tmp = () => mkdtempSync(join(tmpdir(), "anamnesis-a10-"));
const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

const post = (id: number, date: string, text: string) => JSON.stringify({ id, chat_id: -100123, date, sender_id: 1, text, views: 10 });
const HISTORY = [
  post(9, "2026-09-11 16:14:20+00:00", "Про #SEO и #директ: секретный текст поста 9"),
  post(8, "2026-09-01 10:00:00+00:00", "ещё про #seo, без директа"),
  post(7, "2026-08-20 10:00:00+00:00", "#seo снова и #директ"),
  post(6, "2026-08-10 10:00:00+00:00", "#директ и #seo, и #reels"),
  post(5, "2026-07-05 10:00:00+00:00", "пост без тегов"),
].join("\n");

describe("the Telegram source", () => {
  it("is off by default, like Elba", () => {
    expect(DEFAULT_SOURCES.telegram).toBe(false);
    expect(DEFAULT_SOURCES.elba).toBe(false);
  });

  it("reads only `tg history` of the channels named, keeps counts and hashtags, never the text of a post", async () => {
    const calls: string[][] = [];
    const scan = await scanTelegram({ channels: ["@my_channel", "https://t.me/my_channel", "not a channel"], since: Date.UTC(2026, 0, 1), until: Date.UTC(2026, 9, 8),
      tg: async (args) => { calls.push(args); return HISTORY; } });
    expect(calls).toHaveLength(1);                                   // the same channel written twice is read once, the junk is not a channel
    expect(calls[0]!.slice(0, 2)).toEqual(["history", "@my_channel"]);
    expect(calls[0]).toEqual(expect.arrayContaining(["--limit", "500", "--after", "2026-01-01T00:00:00.000Z", "--before", "2026-10-08T00:00:00.000Z"]));
    expect(scan.items).toBe(5);
    const project = scan.records.find((r) => r.kind === "project")!;
    expect(project).toMatchObject({ key: "telegram:@my_channel", attributes: { posts: 5, byMonth: { "2026-07": 1, "2026-08": 2, "2026-09": 2 } } });
    expect(project.evidence[0]).toMatchObject({ source: "telegram", ref: "tg:@my_channel/5" });
    expect(scan.records.filter((r) => r.kind === "interest").map((r) => r.title).sort()).toEqual(["#seo", "#директ"]);   // #reels was one post, #директ three
    expect(JSON.stringify(scan.records)).not.toContain("секретный текст");
  });

  it("says what to do when no channel is named, and fails a channel the tool refuses", async () => {
    const tg = vi.fn(async () => "");
    expect((await scanTelegram({ channels: [], since: 0, until: 1, tg })).note).toMatch(/--telegram-channels/);
    expect(tg).not.toHaveBeenCalled();
    await expect(scanTelegram({ channels: ["@my_channel"], since: 0, until: 1, tg: async () => JSON.stringify({ error: "FloodWaitError", retry_after_seconds: 30 }) })).rejects.toThrow(/FloodWaitError/);
    expect(parseHistory(`${post(1, "2026-09-01 10:00:00+00:00", "x")}\nnot json\n\n{"id":"a"}`)).toHaveLength(1);
  });

  it("knows a channel by @name or link and finds the tool where the BB machine says", () => {
    expect(channelName("@my_channel")).toBe("@my_channel");
    expect(channelName("t.me/my_channel/")).toBe("@my_channel");
    expect(channelName("https://t.me/my_channel/123")).toBeNull();      // a post link is not a channel
    expect(channelName("me")).toBeNull();                               // «me» (Saved Messages) is not the owner's channel
    expect(tgPath("/Users/o", {})).toBe("/Users/o/toolkit/telegram/tg");
    expect(tgPath("/Users/o", { TG_TOOLKIT_ROOT: "/opt/tg" })).toBe("/opt/tg/tg");
  });
});

describe("the Elba source", () => {
  const TERMS = { client: "ООО «ВМС Тракс»", inn: "8603202700", contract_amount_rub: 41234, invoice_final_rub: 17000, elba_created: true, invoice_number: 147, invoice_date: "2026-09-12",
    invoice_file: "output/Счёт_№147.pdf", invoice_url: "https://elba.kontur.ru/secret-scope", contract_service_name: "Услуги по управлению рекламными кампаниями", pay_account: "40702810200000012345" };

  it("reads the deal files of the kontur-elba skill into a client and an invoice, both sensitive, with no amount, INN, bank detail or link", async () => {
    const root = tmp();
    write(join(root, "ИП", "clients", "vms-trucks", "terms.json"), JSON.stringify(TERMS));
    write(join(root, "ИП", "clients", "draft-deal", "terms.json"), JSON.stringify({ client: "Черновик", elba_created: false }));
    write(join(root, "ИП", "clients", "broken", "terms.json"), "{ not json");
    write(join(root, "node_modules", "clients", "x", "terms.json"), JSON.stringify(TERMS));
    const scan = await scanElba([root]);
    expect(scan.items).toBe(1);
    const person = scan.records.find((r) => r.kind === "person" && r.title.includes("ВМС"))!;
    const event = scan.records.find((r) => r.kind === "event")!;
    expect(person).toMatchObject({ sensitivity: "sensitive", attributes: { relation: "client" }, statement: "Client; service: Услуги по управлению рекламными кампаниями" });
    expect(event).toMatchObject({ title: "Invoice No 147 to ООО «ВМС Тракс»", sensitivity: "sensitive", firstSeen: Date.UTC(2026, 8, 12, 12) });
    expect(event.evidence[0]).toMatchObject({ source: "elba" });
    const dump = JSON.stringify(scan.records);
    for (const secret of ["8603202700", "17000", "41234", "40702810200000012345", "secret-scope", ".pdf"]) expect(dump).not.toContain(secret);
    expect(scan.records).toHaveLength(2);                                      // the deal that was not made in Elba and the broken file leave nothing
  });

  it("says when there is nothing to read", async () => {
    expect((await scanElba([tmp()])).note).toMatch(/no clients/);
  });
});

describe("behind the switches", () => {
  const request = { mode: "run" as const, sources: ["telegram", "elba"] as const, roots: ["/x"], telegramChannels: ["@my_channel"], since: 0, until: Date.UTC(2026, 9, 8) };

  it("does not read a source that is off, reads it once it is switched on, and `forget --source` takes everything it taught", async () => {
    store = openStore(":memory:");
    const telegram = vi.fn(async () => ({ source: "telegram" as const, items: 1, records: [{ kind: "interest" as const, key: "tg-tag:seo", title: "#seo", evidence: [{ source: "telegram" as const, ref: "tg:@my_channel/9", at: 5 }] }] }));
    const elba = vi.fn(async () => ({ source: "elba" as const, items: 0, records: [] }));
    const seams = { scans: { telegram, elba } };
    const off = await collectSources(request, store, seams);
    expect(off.sources.map((s) => [s.source, s.enabled, s.note])).toEqual([["telegram", false, "switched off"], ["elba", false, "switched off"]]);
    expect(telegram).not.toHaveBeenCalled();
    expect(elba).not.toHaveBeenCalled();

    store.setSource("telegram", true);
    const on = await collectSources(request, store, seams);
    expect(on.sources[0]).toMatchObject({ source: "telegram", enabled: true, records: 1 });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(elba).not.toHaveBeenCalled();
    expect(store.counts().records).toBe(1);

    expect(store.forgetSource("telegram")).toMatchObject({ records: 1 });
    expect(store.counts().records).toBe(0);
    expect(store.sourceEnabled("telegram")).toBe(false);
  });
});
