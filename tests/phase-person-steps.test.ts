import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { acceptanceKey, acceptanceLines, nextAction, sha256, type Phase, type PhaseRecord } from "../src/rooms/phase/logic";
import { listParts, savePhase } from "../src/rooms/phase/store";
import { createRun, openDatabase } from "../src/rooms/storage";

// The person steps of the SMA map (481d75c2), on by default since 2026-10-29 (owner.words): the context is signed by a person (p1_confirm),
// the phase package is decided by a person under its key with two decisions (p6_decide, p6_l_useful, p6_l_limits), and a lesson is a draft
// until the person applies it (p7_staged, m_apply); the reviewer of the lessons names the hash of the very analysis it read (p7_saw_bytes).
const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
afterEach(() => { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; });

async function fixture(ownerWords: boolean) {
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = ownerWords ? "on" : "off";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const services = { runBudgets: { get: () => undefined }, readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha256(path), sizeBytes: 120, content: `# ${path}` }) };
  const { phases } = createPhaseDriver(createCore(bb, db), services as never);
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "sums skip empty cells" });
  return { db, phases, id: phase.id };
}

const card = { docs: [".agents/phases/CONTEXT.md"], risks: { value: "users miss totals", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["no new screens"] };

describe("the context signature", () => {
  it("[sma:p1_confirm] waits for the person's word with owner.words on, and goes to planning on his yes", async () => {
    const { phases, id } = await fixture(true);
    const signed = await phases.context({ phaseId: id, ...card });
    expect(signed.stage).toBe("discussion");
    expect(nextAction(signed, new Map()).key).toBe("discussion:word:context");
    const yes = await phases.word({ phaseId: id, turn: "context", decision: "yes", text: "да", by: "owner via screen" });
    expect(yes.stage).toBe("planning");
  });

  it("[sma:p1_confirm] is unsigned by the person's no, and his words go to the next analysis", async () => {
    const { phases, id } = await fixture(true);
    await phases.context({ phaseId: id, ...card });
    const no = await phases.word({ phaseId: id, turn: "context", decision: "no", text: "the appetite is a week, not a day", by: "owner via screen" });
    expect(no.stage).toBe("discussion");
    expect(no.record.context).toBeUndefined();
  });

  it("[sma:p1_appetite] refuses a context without an appetite or without no-gos", async () => {
    const { phases, id } = await fixture(false);
    await expect(phases.context({ phaseId: id, ...card, appetite: "" })).rejects.toMatchObject({ why: [expect.stringContaining("no appetite")] });
    await expect(phases.context({ phaseId: id, ...card, noGos: [] })).rejects.toMatchObject({ why: [expect.stringContaining("no-gos not named")] });
  });

  it("[sma:p1_risks] names the four risk kinds of SMA: value, usability, feasibility, viability", async () => {
    const { phases, id } = await fixture(false);
    await expect(phases.context({ phaseId: id, ...card, risks: { technical: "t", product: "p", operations: "o" } as never }))
      .rejects.toMatchObject({ why: [expect.stringContaining("risks not named: value, usability, feasibility, viability")] });
    expect((await phases.context({ phaseId: id, ...card })).stage).toBe("planning");
  });
});

const prepared = (extra: Partial<PhaseRecord> = {}): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "g", stage: "acceptance", state: "active", edition: 1, createdAt: 0, updatedAt: 0,
  record: { ownerWords: true, plan: { items: [], sha: "plan", contextSha: "c", admittedSha: "plan" },
    verification: { verdict: { state: "passed", detail: "ok", mainSha: "abc", at: 1, inputSha: "in1" }, model: { state: "met", by: "auditor", summary: "met", at: 1 } }, ...extra },
});
const lines = (phase: Phase) => Object.fromEntries(acceptanceLines(phase, new Map(), { mainSha: "abc", openDeferrals: 0 }).map((line) => [line.id, line.ok]));

describe("the keyed decision on the phase", () => {
  it("[sma:p6_decide] holds the two person lines until both decisions are said under the shown package's key", () => {
    const phase = prepared();
    expect(lines(phase)).toMatchObject({ result_useful: false, limits_acknowledged: false });
    expect(nextAction({ ...phase, record: { ...phase.record, acceptance: { lines: acceptanceLines(phase, new Map(), { mainSha: "abc", openDeferrals: 0 }), at: 1, accepted: false } } }, new Map()).key)
      .toBe(`acceptance:word:acceptance:${acceptanceKey(phase.record)}`);
    const decided = prepared({ words: [{ turn: "acceptance", decision: "yes", by: "owner", text: "да", at: 2, useful: true, limits: true, key: acceptanceKey(phase.record) }] });
    expect(lines(decided)).toMatchObject({ result_useful: true, limits_acknowledged: true });
  });

  it("[sma:p6_stale] does not count a word given on another package: a new verdict asks the person again", () => {
    const old = prepared();
    const word = { turn: "acceptance" as const, decision: "yes" as const, by: "owner", text: "да", at: 2, useful: true, limits: true, key: acceptanceKey(old.record) };
    const moved = prepared({ words: [word], verification: { verdict: { state: "passed", detail: "ok", mainSha: "def", at: 3, inputSha: "in2" }, model: { state: "met", by: "auditor", summary: "met", at: 3 } } });
    expect(lines({ ...moved })).toMatchObject({ result_useful: false });
  });

  it("[sma:p6_l_useful] refuses a yes that does not say both decisions", async () => {
    const { phases, id } = await fixture(true);
    await expect(phases.word({ phaseId: id, turn: "acceptance", decision: "yes", text: "да", useful: true, by: "owner via screen" })).rejects.toThrow(/two decisions/);
  });
});

describe("the lessons", () => {
  async function atLessons(ownerWords: boolean) {
    const f = await fixture(ownerWords);
    const phase = f.phases.status(f.id).phase;
    savePhase(f.db, f.id, { stage: "lessons", record: { ...phase.record, lessons: { needed: true, why: "a return" } }, at: 2 });
    return f;
  }
  const analysis = "The plan missed the empty-cell case; a check per promise would have caught it.";

  it("[sma:p7_saw_bytes] takes the review only for the hash of exactly the analysis it read, not the book's", async () => {
    const { db, phases, id } = await atLessons(false);
    const head = listParts(db, id).at(-1)!.hash;
    expect(() => phases.lessons({ phaseId: id, analysis, author: "retro", reviewer: "stage", reviewedHash: head })).toThrow(/other bytes/);
    expect(phases.lessons({ phaseId: id, analysis, author: "retro", reviewer: "stage", reviewedHash: sha256(analysis) }).stage).toBe("closed");
  });

  it("[sma:p7_staged] keeps the lesson a draft for the person's word with owner.words on; his yes writes it to memory", async () => {
    const { db, phases, id } = await atLessons(true);
    const closed = phases.lessons({ phaseId: id, analysis, author: "retro", reviewer: "stage", reviewedHash: sha256(analysis) });
    expect(closed.stage).toBe("closed");
    expect(closed.record.lessons?.draft?.state).toBe("staged");
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory_fts WHERE project_id='projA'").get() as { n: number }).n;
    expect(count()).toBe(0);
    const applied = await phases.word({ phaseId: id, turn: "lesson", decision: "yes", text: "да", by: "owner via screen" });
    expect(applied.record.lessons?.draft?.state).toBe("applied");
    expect(count()).toBe(1);
  });
});
