import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnamnesisCli } from "../../src/rooms/anamnesis/cli";
import { anamnesisHandler } from "../../src/rooms/anamnesis/host";
import { createHub } from "../../src/rooms/anamnesis/hub";
import type { AnamnesisRecord } from "../../src/rooms/anamnesis/model";
import { renderCard, renderWhoami, type WhoamiRecord } from "../../src/rooms/anamnesis/whoami";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8);
let n = 0;
const rec = (over: Partial<AnamnesisRecord> & { evidence?: WhoamiRecord["evidence"] }): WhoamiRecord => ({
  id: `x:${++n}`, kind: "fact", title: `title ${n}`, statement: "", attributes: {}, sensitivity: "private", confidence: 0.9, status: "confirmed",
  firstSeen: NOW - 100 * DAY, lastSeen: NOW - 10 * DAY, manualAt: 0, createdAt: NOW, updatedAt: NOW, evidenceCount: 3, ...over,
});

const SET: WhoamiRecord[] = [
  rec({ kind: "fact", title: "Runs a small agency", statement: "Marketing and agent systems" }),
  rec({ kind: "skill", title: "TypeScript", attributes: { commits: 900 }, status: "draft", confidence: 0.8 }),
  rec({ kind: "skill", title: "Blender", attributes: { commits: 30 } }),
  rec({ kind: "project", title: "Lane Pilot", statement: "Orchestrator", lastSeen: NOW - 2 * DAY }),
  rec({ kind: "project", title: "Old thing", lastSeen: NOW - 400 * DAY }),
  rec({ kind: "event", title: "First release", firstSeen: Date.UTC(2026, 8, 20) }),
  rec({ kind: "event", title: "Second release", firstSeen: Date.UTC(2026, 9, 2) }),
  rec({ kind: "preference", title: "Reports in Russian", statement: "short, no filler" }),
  rec({ kind: "person", title: "Anna the client", sensitivity: "sensitive" }),
  rec({ kind: "person", title: "Ivan the colleague" }),
  rec({ kind: "fact", title: "Public bio", sensitivity: "public" }),
  rec({ kind: "skill", title: "Rejected skill", status: "rejected" }),
  rec({ kind: "fact", title: "Candidate fragment", status: "candidate" }),
];

describe("who am I", () => {
  it("shows sections with confidence, evidence and dates, marks drafts, and never shows candidates or rejected records", () => {
    const result = renderWhoami(SET, { detail: "normal" });
    expect(result.text).toContain("## Skills (2)");
    expect(result.text).toMatch(/Blender \(confidence high, 3 evidence/);
    expect(result.text).toMatch(/TypeScript \[draft\]/);
    expect(result.text.indexOf("TypeScript")).toBeLessThan(result.text.indexOf("Blender"));   // more commits first
    expect(result.text).not.toMatch(/Rejected skill|Candidate fragment/);
    expect(result.drafts).toBe(1);
    expect(result.text).toContain("still drafts you have not confirmed");
  });

  it("hides sensitive records and says only how many; shows them on the explicit flag", () => {
    const plain = renderWhoami(SET);
    expect(plain.text).not.toContain("Anna");
    expect(plain.text).toContain("1 sensitive records");
    expect(plain.hiddenSensitive).toBe(1);
    const asked = renderWhoami(SET, { includeSensitive: true });
    expect(asked.text).toContain("Anna the client");
    expect(asked.text).not.toContain("sensitive records (family");
  });

  it("public-only keeps just what the owner marked public", () => {
    const result = renderWhoami(SET, { publicOnly: true });
    expect(result.text).toContain("Public bio");
    expect(result.text).not.toMatch(/Blender|Ivan|Anna/);
    expect(result.text).not.toContain("sensitive records");
  });

  it("levels of detail: brief is a line per section, full lists evidence pointers", () => {
    const brief = renderWhoami(SET, { detail: "brief", sections: ["skills", "projects"] });
    expect(brief.text).toContain("TypeScript [draft]; Blender");
    expect(brief.text).not.toContain("confidence");
    const full = renderWhoami([rec({ kind: "skill", title: "Go", evidence: [{ source: "git", ref: "r@abc", at: NOW - DAY }] })], { detail: "full", sections: ["skills"] });
    expect(full.text).toContain("evidence: " + new Date(NOW - DAY).toISOString().slice(0, 10) + " git r@abc");
  });

  it("the timeline is grouped by month, oldest first, and limited sections are respected", () => {
    const text = renderWhoami(SET, { sections: ["timeline"] }).text;
    expect(text.indexOf("### 2026-09")).toBeLessThan(text.indexOf("### 2026-10"));
    expect(text).not.toContain("## Skills");
  });

  it("states an empty anamnesis plainly and can be limited to confirmed records", () => {
    expect(renderWhoami([]).text).toContain("Nothing recorded yet");
    const confirmed = renderWhoami(SET, { includeDrafts: false });
    expect(confirmed.text).not.toContain("TypeScript");
  });
});

describe("the card for the PM", () => {
  it("holds only confirmed, non-sensitive records, current projects and fits the limit", () => {
    const card = renderCard(SET, { now: NOW });
    expect(card.text).toMatch(/not instructions/);
    expect(card.text).toContain("Skills: Blender");
    expect(card.text).not.toMatch(/TypeScript|Anna|Candidate|Rejected|Old thing/);
    expect(card.text).toContain("Current projects: Lane Pilot");
    expect(card.text).toContain("Preferences: short, no filler");
    expect(card.chars).toBe(card.text.length);
    expect(renderCard(SET, { now: NOW, maxChars: 200 }).chars).toBeLessThanOrEqual(200);
  });
  it("an anamnesis nobody confirmed yields an empty card that forbids inventing", () => {
    expect(renderCard(SET.map((r) => ({ ...r, status: "draft" as const })), { now: NOW }).text).toContain("No confirmed facts yet. Do not invent them.");
  });
});

describe("who am I in Russian", () => {
  const PORTRAIT: WhoamiRecord[] = [
    rec({ kind: "self", title: "Ценю честность", statement: "Ценю честность и прямоту в работе" }),
    rec({ kind: "fact", title: "Живёт в Мадриде" }),
    rec({ kind: "knowledge", title: "SEO", statement: "Знаю SEO и контент-маркетинг" }),
    rec({ kind: "skill", title: "TypeScript", statement: "Commits touching 90 TypeScript files in 3 repositories, 2025-01 to 2026-10", attributes: { origin: "git", commits: 90, level: "confident" } }),
    rec({ kind: "person", title: "Анна", statement: "Жена Анна, врач", sensitivity: "sensitive" }),
    rec({ kind: "hobby", title: "Играю на гитаре", statement: "Играю на гитаре по вечерам", status: "draft" }),
    rec({ kind: "interest", title: "Кино", statement: "Люблю кино Тарковского" }),
    rec({ kind: "event", title: "Переехал в Мадрид", firstSeen: Date.UTC(2024, 2, 5) }),
    rec({ kind: "preference", title: "Отчёты", statement: "Отчёты по-русски, коротко" }),
    rec({ kind: "project", title: "Lane Pilot", statement: "Orchestrator" }),
    rec({ kind: "tool", title: "Mac mini" }),
  ];

  it("has Russian headings in the order of the portrait, and no English raw text", () => {
    const { text } = renderWhoami(PORTRAIT, { locale: "ru", includeSensitive: true });
    const headings = [...text.matchAll(/^## (.+?) \(\d+\)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(["Кто я", "Знания", "Умения", "Семья и близкие", "Хобби", "Интересы", "Предпочтения", "Хронология"]);
    expect(text).toContain("Что я о вас знаю");
    expect(text).toContain("[черновик]");
    expect(text).toMatch(/Жена Анна, врач/);
    // A skill from git is told in Russian, not with the English statement.
    expect(text).toContain("TypeScript — уверенно");
    expect(text).not.toMatch(/Commits touching|confidence|evidence|Skills|\[draft\]/);
    // The work (projects, tools) is not part of the portrait unless asked for.
    expect(text).not.toMatch(/Lane Pilot|Mac mini/);
    expect(renderWhoami(PORTRAIT, { locale: "ru", sections: ["projects", "tools"] }).text).toMatch(/## Проекты \(1\)[\s\S]*Lane Pilot[\s\S]*## Инструменты и окружение \(1\)/);
  });

  it("hides sensitive records in Russian too and says how many", () => {
    const { text, hiddenSensitive } = renderWhoami(PORTRAIT, { locale: "ru" });
    expect(hiddenSensitive).toBe(1);
    expect(text).not.toContain("Анна");
    expect(text).toContain("Чувствительных записей (семья, здоровье, деньги, клиенты, документы): 1");
    expect(renderWhoami([], { locale: "ru" }).text).toContain("Пока ничего не записано");
  });

  it("English stays English for the English locale, with the portrait sections only by default", () => {
    const { text } = renderWhoami(PORTRAIT, { locale: "en", includeSensitive: true });
    expect(text).toContain("What I know about you");
    expect(text).toMatch(/## Who \(2\)[\s\S]*## Knowledge \(1\)[\s\S]*## Skills \(1\)[\s\S]*## People \(1\)[\s\S]*## Hobbies \(1\)/);
    expect(text).toContain("[draft]");
    expect(text).not.toMatch(/Lane Pilot|Mac mini/);
  });
});

describe("whoami through the hub, the host and the command", () => {
  const previous = process.env.LANE_PILOT_ANAMNESIS_DIR;
  let hub: ReturnType<typeof createHub>;
  beforeEach(async () => {
    process.env.LANE_PILOT_ANAMNESIS_DIR = mkdtempSync(join(tmpdir(), "anamnesis-who-"));
    hub = createHub({
      hostCall: async (hostId, request) => (await anamnesisHandler({ requestedHostId: hostId, request })).response,
      listHosts: async () => [{ id: "mini", name: "Mac mini", connected: true }], kv: { get: async () => null, set: async () => undefined },
    });
    const ev = (ref: string) => [{ source: "git", ref, at: NOW - DAY }];
    await hub.ask({ op: "upsert", actor: "auto:git", reason: "t", records: [
      { kind: "skill", key: "Rust", title: "Rust", statement: "systems", evidence: ev("a@1") },
      { kind: "preference", key: "russian", title: "Reports in Russian", evidence: ev("a@2") },
      { kind: "person", key: "Anna", title: "Anna", attributes: { relation: "family" }, evidence: ev("a@3") },
    ] });
  });
  afterEach(() => { if (previous === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previous; });
  const cli = (argv: string[]) => runAnamnesisCli(argv, { hub });

  it("answers with text only, drafts marked, the sensitive record counted but not shown", async () => {
    const out = (await cli(["whoami"])).stdout!;
    expect(out).toContain("Rust — systems [draft]");
    expect(out).toContain("1 sensitive records");
    expect(out).not.toContain("Anna");
    expect((await cli(["whoami", "--include-sensitive"])).stdout).toContain("Anna");
  });

  it("the card is empty until the owner confirms, then carries the confirmed record", async () => {
    expect((await cli(["card"])).stdout).toContain("No confirmed facts yet");
    await cli(["confirm", "preference:russian"]);
    const card = (await cli(["card"])).stdout!;
    expect(card).toContain("Preferences: Reports in Russian");
    expect(card).not.toMatch(/Rust|Anna/);
  });

  it("rejects an unknown section or detail before asking the host", async () => {
    expect((await cli(["whoami", "--sections", "secrets"])).stderr).toMatch(/section must be one of/);
    expect((await cli(["whoami", "--detail", "huge"])).stderr).toMatch(/detail must be one of/);
  });

  it("on a machine without a store it answers from nothing and creates no file", async () => {
    process.env.LANE_PILOT_ANAMNESIS_DIR = join(tmpdir(), `anamnesis-none-${Date.now()}`);
    expect((await cli(["whoami"])).stdout).toContain("Nothing recorded yet");
    expect((await cli(["card"])).stdout).toContain("No confirmed facts yet");
    expect((await import("node:fs")).existsSync(process.env.LANE_PILOT_ANAMNESIS_DIR)).toBe(false);
  });
});
