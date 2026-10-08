import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnamnesisCli } from "../../src/anamnesis/cli";
import { hostContract } from "../../src/contracts";
import { anamnesisHandler } from "../../src/anamnesis/host";
import { createHub } from "../../src/anamnesis/hub";
import type { FragmentDecision } from "../../src/anamnesis/judgment";
import { DEFAULT_MAX_CLASSIFY, HARD_MAX_CLASSIFY, JEV_TOKENS_PER_MESSAGE, formatReport, loadAnamnesis, type LoadDeps } from "../../src/anamnesis/load";
import type { EventLike, ThreadLike, ThreadsPort } from "../../src/anamnesis/owner-messages";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8);
const previousDir = process.env.LANE_PILOT_ANAMNESIS_DIR;
let dir: string, root: string;
let kv: Map<string, unknown>;

const thread = (id: string, projectId: string): ThreadLike => ({ id, projectId, createdAt: NOW - 300 * DAY, visibility: "visible" });
let seq = 0;
const turn = (text: string, daysAgo: number): EventLike => ({ seq: ++seq, type: "client/turn/requested", createdAt: NOW - daysAgo * DAY, data: { initiator: "user", requestId: `r${seq}`, input: [{ type: "text", text }] } });

function port(events: Record<string, EventLike[]>): ThreadsPort {
  const threads = Object.keys(events).map((id) => thread(id, id.startsWith("thr_sa") ? "proj_selfy" : "proj_bb"));
  return {
    listThreads: async ({ offset, limit }) => threads.slice(offset, offset + limit),
    listEvents: async ({ threadId, beforeSeq, limit }) => [...(events[threadId] ?? [])].sort((a, b) => b.seq - a.seq).filter((e) => beforeSeq === undefined || e.seq < beforeSeq).slice(0, limit),
  };
}

function makeDeps(events: Record<string, EventLike[]>, judge?: LoadDeps["judge"]): LoadDeps {
  const hub = createHub({
    hostCall: async (hostId, request) => hostContract.anamnesis.output.parse(await anamnesisHandler(hostContract.anamnesis.input.parse({ requestedHostId: hostId, request }))).response,
    listHosts: async () => [{ id: "host_mini", name: "MAC Mini", connected: true }],
    kv: { get: async <T>(key: string) => kv.get(key) as T | undefined, set: async (key, value) => { kv.set(key, value); } },
  });
  return {
    hub, threads: port(events), now: () => NOW,
    projectNames: async () => new Map([["proj_bb", "BB-сервис"], ["proj_selfy", "SelfyStudio"]]),
    lpRuns: () => [{ id: "lprun_1", projectId: "proj_bb", createdAt: NOW - 20 * DAY }, { id: "lprun_2", projectId: "proj_bb", createdAt: NOW - 3 * DAY }, { id: "lprun_old", projectId: "proj_bb", createdAt: NOW - 900 * DAY }],
    ...(judge ? { judge } : {}),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "anamnesis-load-"));
  root = mkdtempSync(join(tmpdir(), "anamnesis-root-"));
  process.env.LANE_PILOT_ANAMNESIS_DIR = join(dir, "store");
  kv = new Map();
  const journal = join(root, "BB-сервис", "docs", "project-life", "journal");
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, "2026-09-20-release.md"), "# First release\n");
  kv.set("anamnesis:config", { roots: [root], authors: ["nobody@example.com"] });
});
afterEach(() => { if (previousDir === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previousDir; });

const EVENTS = () => ({
  thr_bb1: [turn("Всегда пиши отчёты по-русски, коротко и без воды, пожалуйста", 30), turn("ok", 29), turn("запусти тесты ещё раз и покажи результат прогона", 5), turn("мой сын пошёл в школу, поэтому по утрам меня не будет на связи", 2)],
  thr_sa1: [turn("Я веду небольшое агентство и делаю сайты для клиентов в Мадриде", 100)],
});
const SOURCES = ["git", "journal", "registry", "bb-message", "lp-runs"] as const;

describe("the first load", () => {
  it("a plan counts everything, prices the Jev pass, sends nothing and leaves no file on the machine", async () => {
    const judge = vi.fn();
    const report = await loadAnamnesis(makeDeps(EVENTS(), judge), { mode: "plan", sources: SOURCES, classify: true });
    expect(judge).not.toHaveBeenCalled();
    expect(report.messages).toMatchObject({ total: 5, threads: 2, projects: 2, tooShort: 1, heldBackSensitive: 1, eligibleForJev: 3 });
    expect(report.lpRuns).toEqual({ enabled: true, runs: 2, projects: 1 });
    expect(report.hostSources.find((s) => s.source === "journal")).toMatchObject({ items: 1, records: 1, outcome: { created: 1 } });
    expect(report.cost).toMatchObject({ jevMessages: 3, estimatedTokens: 3 * JEV_TOKENS_PER_MESSAGE });
    expect(report.classify?.note).toMatch(/no fragment is sent/);
    expect(existsSync(join(dir, "store"))).toBe(false);
    expect(formatReport(report)).not.toMatch(/отчёты|агентство|сын/);
  });

  it("a run stores drafts: projects from messages and runs, journal events, checkpoints; nothing is confirmed", async () => {
    const deps = makeDeps(EVENTS());
    const report = await loadAnamnesis(deps, { mode: "run", sources: SOURCES });
    expect(report.hubRecords?.stored?.counts).toEqual({ created: 2, updated: 1 });   // BB-сервис gets runs on top of messages
    const status = await deps.hub.ask({ op: "status" });
    expect(status.counts.byStatus).toEqual({ draft: 3 });
    expect(status.sources.find((s) => s.source === "bb-message")!.checkpoint).toBe(NOW);
    expect(status.loads).toHaveLength(1);
    const { record } = await deps.hub.ask({ op: "get", id: "project:bb-сервис" });
    expect(record).toMatchObject({ attributes: { messages: 4, threads: 1, lpRuns: 2 } });
    expect(record!.evidence.map((e) => e.source).sort()).toEqual(["bb-message", "bb-message", "bb-message", "bb-message", "lp-runs", "lp-runs"]);
    expect(record!.evidence.every((e) => !e.quote)).toBe(true);
    const again = await loadAnamnesis(deps, { mode: "run", sources: SOURCES });
    expect(again.hubRecords?.stored?.counts).toEqual({ unchanged: 3 });
  });

  it("classifies only when asked: fragments are masked, locally sensitive ones held back, results become candidates", async () => {
    const sent: string[] = [];
    const judge: LoadDeps["judge"] = async (texts) => { sent.push(...texts); return texts.map((text): FragmentDecision | null =>
      text.includes("отчёты") ? { kind: "preference", kindP: 0.9, aboutOwner: 0.95, sensitive: 0.05 }
        : text.includes("агентство") ? { kind: "fact", kindP: 0.8, aboutOwner: 0.9, sensitive: 0.6 }
        : text.includes("запусти") ? { kind: "nothing", kindP: 0.9, aboutOwner: 0.1, sensitive: 0 } : null); };
    const deps = makeDeps({ thr_bb1: [...EVENTS().thr_bb1, turn("мой ключ API_KEY=supersecretvalue99 нужен для отчёты", 4)], thr_sa1: EVENTS().thr_sa1 }, judge);
    const report = await loadAnamnesis(deps, { mode: "run", sources: SOURCES, classify: true });
    expect(sent).toHaveLength(4);
    expect(sent.join("\n")).not.toMatch(/supersecretvalue99|сын/);
    expect(report.classify).toMatchObject({ asked: 4, kept: 3, nothing: 1, unavailable: 0 });
    const { records } = await deps.hub.ask({ op: "list", statuses: ["candidate"], includeSensitive: true });
    expect(records).toHaveLength(3);
    const agency = records.find((r) => r.statement.includes("агентство"))!;
    expect(agency).toMatchObject({ kind: "fact", sensitivity: "sensitive", status: "candidate" });
    expect((await deps.hub.ask({ op: "list", statuses: ["candidate"] })).records.map((r) => r.id)).not.toContain(agency.id);
    const full = (await deps.hub.ask({ op: "get", id: agency.id, includeSensitive: true })).record!;
    expect(full.evidence[0]).toMatchObject({ source: "bb-message", quote: expect.stringContaining("агентство") });
    expect(full.attributes).toMatchObject({ origin: "jev-fragment" });
  });

  it("holds sensitive fragments back unless the owner allows them, and counts a fragment Jev could not judge", async () => {
    const judge: LoadDeps["judge"] = async (texts) => texts.map(() => null);
    const deps = makeDeps(EVENTS(), judge);
    const withheld = await loadAnamnesis(deps, { mode: "run", sources: ["bb-message"], classify: true });
    expect(withheld.classify).toMatchObject({ asked: 3, unavailable: 3, kept: 0 });
    const allowed = await loadAnamnesis(deps, { mode: "run", sources: ["bb-message"], classify: true, allowSensitiveToJev: true });
    expect(allowed.classify!.asked).toBe(4);
    const noJev = await loadAnamnesis(makeDeps(EVENTS()), { mode: "run", sources: ["bb-message"], classify: true });
    expect(noJev.classify?.note).toMatch(/Jev is not available/);
  });

  it("caps the Jev pass at the newest messages and prices the cap", async () => {
    const sent: string[] = [];
    const report = await loadAnamnesis(makeDeps(EVENTS(), async (texts) => { sent.push(...texts); return texts.map(() => null); }), { mode: "run", sources: ["bb-message"], classify: true, maxClassify: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("запусти");
    expect(report.cost.jevMessages).toBe(1);
  });

  it("respects switched-off sources and a narrower window", async () => {
    const deps = makeDeps(EVENTS());
    await deps.hub.ask({ op: "sources", set: { source: "bb-message", enabled: false } });
    const report = await loadAnamnesis(deps, { mode: "plan", sources: SOURCES, since: NOW - 10 * DAY });
    expect(report.messages).toBeNull();
    expect(report.lpRuns!.runs).toBe(1);
    expect(report.hostSources.find((s) => s.source === "journal")!.records).toBe(1);
  });
});

describe("bb lane-pilot anamnesis load, review, config", () => {
  const cli = (deps: LoadDeps, argv: string[]) => runAnamnesisCli(argv, { hub: deps.hub, deny: async () => null, load: (options) => loadAnamnesis(deps, options) });

  it("plans by default, and sending to Jev needs --yes", async () => {
    const deps = makeDeps(EVENTS(), async (texts) => texts.map(() => null));
    const plan = await cli(deps, ["load", "--sources", "bb-message,lp-runs", "--classify"]);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("Plan only");
    expect(plan.stdout).toContain("tokens");
    const refused = await cli(deps, ["load", "--run", "--classify", "--sources", "bb-message"]);
    expect(refused.stderr).toMatch(/--yes/);
    expect((await cli(deps, ["load", "--allow-sensitive-to-jev"])).stderr).toMatch(/only means something with --classify/);
    expect((await cli(deps, ["load", "--since", "yesterday"])).stderr).toMatch(/YYYY-MM-DD/);
  });

  it("review groups drafts by kind, hides sensitive records and says how many", async () => {
    const deps = makeDeps(EVENTS());
    await loadAnamnesis(deps, { mode: "run", sources: SOURCES });
    await deps.hub.ask({ op: "add", record: { kind: "person", key: "Anna", title: "Anna", attributes: { relation: "family" } }, reason: "told" });
    const review = await cli(deps, ["review"]);
    expect(review.stdout).toContain("## project (2 to review)");
    expect(review.stdout).toContain("## event (1 to review)");
    expect(review.stdout).toMatch(/1 sensitive records are hidden/);
    expect(review.stdout).not.toContain("Anna");
  });

  it("config stores authors and roots for the host sources", async () => {
    const deps = makeDeps(EVENTS());
    const config = JSON.parse((await cli(deps, ["config", "--authors", "a@b.c, Name", "--roots", "/x,/y"])).stdout!);
    expect(config).toMatchObject({ authors: ["a@b.c", "Name"], roots: ["/x", "/y"] });
  });
});

// Audit 2026-10-08 round 4, item 19 (F-5): PII went to Jev unmasked, and one `--classify --yes` had no ceiling.
describe("what leaves for Jev", () => {
  const many = (count: number) => ({ thr_bb1: Array.from({ length: count }, (_, i) => turn(`Сообщение номер ${i} про наши рабочие планы на следующую неделю`, 1 + (i % 200))) });
  const sentTo = async (events: Record<string, EventLike[]>, options: Partial<Parameters<typeof loadAnamnesis>[1]> = {}) => {
    const sent: string[] = [];
    const report = await loadAnamnesis(makeDeps(events, async (texts) => { sent.push(...texts); return texts.map(() => null); }), { mode: "run", sources: ["bb-message"], classify: true, ...options });
    return { sent, report };
  };

  it("masks e-mails, phones, cards, documents and addresses in every fragment, and says how many fragments it touched", async () => {
    const text = "Клиент пишет на anna.k@mail.example, телефон +7 (916) 123-45-67, карта 4111 1111 1111 1111, ИНН 7707083893, живёт на ул. Ленина, д. 5, кв. 12 — собрать все данные";
    const { sent, report } = await sentTo({ thr_bb1: [turn(text, 3)] }, { allowSensitiveToJev: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("Клиент пишет на [email], телефон [phone], карта [card], ИНН [inn], живёт на [address] — собрать все данные");
    expect(sent.join()).not.toMatch(/anna\.k|916|4111|7707083893|Ленина/);
    expect(report.classify).toMatchObject({ asked: 1, masked: 1 });
  });

  it("stops a pass at the ceiling by default, prices the ceiling and says how many were left out", async () => {
    const { sent, report } = await sentTo(many(450));
    expect(sent).toHaveLength(DEFAULT_MAX_CLASSIFY);
    expect(report.cost.jevMessages).toBe(DEFAULT_MAX_CLASSIFY);
    expect(report.cost.estimatedTokens).toBe(DEFAULT_MAX_CLASSIFY * JEV_TOKENS_PER_MESSAGE);
    expect(report.cost.note).toContain(`ceiling of ${DEFAULT_MAX_CLASSIFY}`);
    expect(report.cost.note).toContain(`${450 - DEFAULT_MAX_CLASSIFY} more`);
    expect(formatReport(report)).toContain("ceiling");
  });

  it("takes the ceiling from the setting, and an explicit number may not go past the hard limit", async () => {
    kv.set("anamnesis:config", { ...(kv.get("anamnesis:config") as object), maxClassify: 30 });
    expect((await sentTo(many(100))).sent).toHaveLength(30);
    expect((await sentTo(many(100), { maxClassify: 60 })).sent).toHaveLength(60);
    const wild = await sentTo(many(HARD_MAX_CLASSIFY + 50), { maxClassify: 1_000_000 });
    expect(wild.sent).toHaveLength(HARD_MAX_CLASSIFY);
  });

  it("the plan prices the same ceiling that a run would apply", async () => {
    const plan = await loadAnamnesis(makeDeps(many(450)), { mode: "plan", sources: ["bb-message"], classify: true });
    expect(plan.cost.jevMessages).toBe(DEFAULT_MAX_CLASSIFY);
  });

  it("config --max-classify sets the ceiling", async () => {
    const deps = makeDeps(EVENTS());
    const cli = (argv: string[]) => runAnamnesisCli(argv, { hub: deps.hub, deny: async () => null, load: (options) => loadAnamnesis(deps, options) });
    expect(JSON.parse((await cli(["config", "--max-classify", "50"])).stdout!)).toMatchObject({ maxClassify: 50 });
    expect(await cli(["config", "--max-classify", "0"])).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/whole number/) });
  });
});
