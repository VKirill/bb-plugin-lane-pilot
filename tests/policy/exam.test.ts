import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXAM, EXAM_LIVE, EXAM_RESULT_KEY, authorize, examSchema, liveExamSchema, policyHash, runExam, runLiveExam, unseenItems, type Exam, type LiveItem } from "../../src/rooms/policy/exam";
import { POLICY, classifyChange, type Policy } from "../../src/rooms/policy/policy";
import { runPolicyCli } from "../../src/rooms/policy/cli";

const ROOT = join(__dirname, "..", "..");
const proof = { bench_subset_passed: true, auto_revertible: true };
const repair = { kind: "lp_fault_repair", files: ["src/rooms/relay/server/relay.ts"], attrs: proof };

describe("the split between the items the policy was written from and the exam", () => {
  // Version 1 split: design items without since_version against exam v1. Later design items are checked against exam v2 below.
  const v1Design = POLICY.design_items.filter((item) => (item.since_version ?? 1) === 1);

  it("no id is on both sides, and no design item sits in the exam", () => {
    const design = new Set(POLICY.design_items.map((item) => item.id));
    for (const item of EXAM.items) expect(design.has(item.id)).toBe(false);
    const designSources = new Set(v1Design.map((item) => item.source));
    for (const item of EXAM.items) if (item.source.type === "rule_proposal") expect(designSources.has(item.source.ref)).toBe(false);
    const designRuleIds = v1Design.flatMap((item) => item.source.match(/rule_[0-9a-f]{16}/g) ?? []);
    for (const item of EXAM.items) for (const id of designRuleIds) expect(item.source.ref.includes(id), `${item.id} is a design rule`).toBe(false);
  });

  it("memory exam items never cite a version-1 design memory file", () => {
    const designFiles = v1Design.map((item) => item.source.replace(/^memory\//, "")).filter((source) => source.endsWith(".md"));
    for (const item of EXAM.items.filter((i) => i.source.type === "memory")) expect(designFiles).not.toContain(item.source.ref);
  });

  it("rule-proposal exam items are dated on or after the time cut (2026-10-15), design items before it", () => {
    for (const item of EXAM.items.filter((i) => i.source.type === "rule_proposal")) expect(item.source.date >= "2026-10-15").toBe(true);
    for (const item of v1Design.filter((i) => /rule_proposal/.test(i.source))) expect(item.date < "2026-10-15").toBe(true);
  });

  it("every item has a unique id, a quote and a source", () => {
    expect(new Set(EXAM.items.map((item) => item.id)).size).toBe(EXAM.items.length);
    expect(() => examSchema.parse(JSON.parse(readFileSync(join(ROOT, "policy", "exam.json"), "utf8")))).not.toThrow();
  });

  it("exam v2 items were all decided after the policy's freeze, or are simply not counted", () => {
    expect(() => liveExamSchema.parse(JSON.parse(readFileSync(join(ROOT, "policy", "exam-v2.json"), "utf8")))).not.toThrow();
    expect(new Set(EXAM_LIVE.items.map((item) => item.id)).size).toBe(EXAM_LIVE.items.length);
  });
});

describe("the frozen policy version", () => {
  it("frozen_hash is the hash of the lists: editing a list without a new freeze fails here", () => {
    expect(POLICY.frozen_hash, "run scripts/policy-exam.ts --hash, bump version, set frozen_at to now, put the hash in frozen_hash").toBe(policyHash(POLICY));
  });

  it("any list edit changes the hash", () => {
    const changed = JSON.parse(JSON.stringify(POLICY)) as Policy;
    changed.night_decides.pop();
    expect(policyHash(changed)).not.toBe(policyHash(POLICY));
    const fewer = JSON.parse(JSON.stringify(POLICY)) as Policy;
    fewer.standing_prohibitions.pop();
    expect(policyHash(fewer)).not.toBe(policyHash(POLICY));
  });

  it("the freeze is not in the future", () => {
    expect(Date.parse(POLICY.frozen_at)).toBeLessThanOrEqual(Date.now());
  });

  it("version 2 design items and prohibition sources are not exam v1 items and not exam v2 items", () => {
    const x = new Set(EXAM.items.map((item) => item.quote.trim().toLowerCase()));
    for (const item of POLICY.design_items.filter((i) => (i.since_version ?? 1) > 1)) expect(x.has(item.quote.trim().toLowerCase()), item.id).toBe(false);
    for (const item of EXAM_LIVE.items) expect(item.id.startsWith("y_")).toBe(true);
  });
});

describe("runExam", () => {
  const item = (id: string, descriptor: Exam["items"][number]["descriptor"], expected: Exam["items"][number]["expected"]): Exam["items"][number] =>
    ({ id, source: { type: "memory", ref: "x.md", date: "2026-01-01" }, quote: "q", descriptor, expected, strength: "strong", why: "w" });
  const exam = (...items: Exam["items"]): Exam => ({ version: 1, labelling: {}, items });

  it("scores accuracy, counts unsafe answers and names the misses", () => {
    const result = runExam(POLICY, exam(
      item("x1", repair, "night_decides"),
      item("x2", { kind: "data_delete" }, "owner_only"),
      item("x3", { kind: "teleport" }, "owner_only"), // unknown -> night_proposes, softer than the owner wanted
      item("x4", { kind: "stage_add" }, "night_decides"), // stricter than needed: wrong but safe
    ));
    expect(result.accuracy).toBe(0.5);
    expect(result.unsafe).toBe(1);
    expect(result.misses.map((m) => m.id)).toEqual(["x3", "x4"]);
    expect(result.answeredByDefault).toBe(1);
    expect(result.confusion).toMatchObject({ "night_decides->night_decides": 1, "owner_only->night_proposes": 1 });
  });

  it("passes at the bar and fails under it; an empty exam never passes", () => {
    const four = [item("x1", repair, "night_decides"), item("x2", { kind: "data_delete" }, "owner_only"), item("x3", { kind: "stage_add" }, "night_proposes"), item("x4", { kind: "teleport" }, "night_decides")];
    expect(runExam(POLICY, exam(...four)).passed).toBe(false); // 3/4 = 0.75
    expect(runExam(POLICY, exam(...four.slice(0, 3))).passed).toBe(true);
    expect(runExam(POLICY, { items: [] }).passed).toBe(false);
  });

  it("the fingerprint follows the policy and the items", () => {
    const base = runExam(POLICY, exam(item("x1", repair, "night_decides"))).fingerprint;
    expect(runExam(POLICY, exam(item("x1", repair, "night_proposes"))).fingerprint).not.toBe(base);
    const changed = JSON.parse(JSON.stringify(POLICY)) as typeof POLICY;
    changed.night_decides.pop();
    expect(runExam(changed, exam(item("x1", repair, "night_decides"))).fingerprint).not.toBe(base);
  });
});

/** A split of `n` owner decisions, `wrong` of them against what the policy answers, all decided `after` ms after the policy's freeze. */
function split(n: number, wrong = 0, after = 60_000): { items: LiveItem[] } {
  const at = new Date(Date.parse(POLICY.frozen_at) + after).toISOString();
  const items = Array.from({ length: n }, (_, index): LiveItem => ({
    id: `y_${index.toString(16).padStart(12, "0")}`, source: { type: "owner_message", ref: `thr_${index}#1`, date: at.slice(0, 10) }, decided_at: at,
    quote: "q", descriptor: repair, expected: index < wrong ? "owner_only" : "night_decides", strength: "strong", why: "w",
  }));
  return { items };
}

describe("exam v2: only decisions made after the freeze score the policy", () => {
  it("items decided at or before the freeze are left out", () => {
    const early = split(3, 0, -1).items, onFreeze = split(2, 0, 0).items, late = split(4).items.map((item, index) => ({ ...item, id: `y_${(100 + index).toString(16).padStart(12, "0")}` }));
    expect(unseenItems(POLICY, { items: [...early, ...onFreeze, ...late] })).toHaveLength(4);
  });

  it("too few unseen items: not passed, says how many are missing", () => {
    const result = runLiveExam(POLICY, split(19));
    expect(result).toMatchObject({ enough: false, passed: false, total: 19, needed: 20, accuracy: 1 });
    expect(result.verdict).toMatch(/NOT ENOUGH UNSEEN DECISIONS YET: 19 of 20/);
  });

  it("seen items do not make up the number", () => {
    const result = runLiveExam(POLICY, { items: [...split(30, 0, -1000).items] });
    expect(result).toMatchObject({ enough: false, total: 0, seenExcluded: 30 });
  });

  it("20 unseen items at the bar pass; one more miss than allowed fails", () => {
    expect(runLiveExam(POLICY, split(20, 4))).toMatchObject({ enough: true, passed: true, accuracy: 0.8 });
    expect(runLiveExam(POLICY, split(20, 5))).toMatchObject({ enough: true, passed: false, accuracy: 0.75 });
  });

  it("the committed split is empty today: the exam has nothing to score yet", () => {
    const result = runLiveExam();
    expect(result.passed).toBe(false);
    expect(result.enough).toBe(EXAM_LIVE.items.filter((item) => Date.parse(item.decided_at) > Date.parse(POLICY.frozen_at)).length >= POLICY.exam.min_items);
  });
});

describe("authorize: the classification is final, the exam is a measurement (the owner takes no part in the loop)", () => {
  it("an LP-fault repair with its proofs is night_decides whatever the exam says", () => {
    for (const exam of [split(0), split(19), split(20, 10), split(40, 0, -3_600_000)]) expect(runLiveExam(POLICY, exam).passed).toBe(false);
    expect(authorize(repair)).toMatchObject({ requested: "night_decides", tier: "night_decides" });
    expect(authorize(repair).reason).not.toMatch(/degraded|DECISIONS/);
  });

  it("a missing proof, a judge's file or data stay out of the night's hands", () => {
    expect(authorize({ ...repair, attrs: { bench_subset_passed: false, auto_revertible: true } }).tier).toBe("night_proposes");
    expect(authorize({ kind: "data_delete" }).tier).toBe("owner_only");
    expect(authorize({ kind: "stage_add" }).tier).toBe("night_proposes");
    expect(authorize({ attrs: { service_tier: "fast" } }).tier).toBe("owner_only");
  });
});

describe("the recorded result matches the current policy and split", () => {
  it("policy/exam-result.json is fresh (rerun scripts/policy-exam.ts --write after editing policy/ and show the owner)", () => {
    const record = JSON.parse(readFileSync(join(ROOT, "policy", "exam-result.json"), "utf8")) as { policyVersion: number; fingerprint: string; accuracy: number; correct: number; total: number; passed: boolean; enough: boolean; needed: number; history: Array<{ policyVersion: number; accuracy: number }> };
    const now = runLiveExam();
    expect({ policyVersion: record.policyVersion, fingerprint: record.fingerprint, accuracy: record.accuracy, correct: record.correct, total: record.total, passed: record.passed, enough: record.enough, needed: record.needed })
      .toEqual({ policyVersion: POLICY.version, fingerprint: now.fingerprint, accuracy: now.accuracy, correct: now.correct, total: now.total, passed: now.passed, enough: now.enough, needed: now.needed });
  });

  it("keeps the first run as history", () => {
    const record = JSON.parse(readFileSync(join(ROOT, "policy", "exam-result.json"), "utf8")) as { history: Array<{ policyVersion: number; correct: number; total: number }> };
    expect(record.history[0]).toMatchObject({ policyVersion: 1, correct: 14, total: 32 });
  });
});

describe("bb lane-pilot policy-exam", () => {
  const store = new Map<string, unknown>();
  const deps = { db: { prepare: () => { throw new Error("not used"); } } as never, kv: { get: async (key: string) => store.get(key) as never, set: async (key: string, value: unknown) => { store.set(key, value); } }, now: () => Date.parse(POLICY.frozen_at) + 3_600_000 };

  it("scores the newest unseen split, stores the result and exits 2 while there are too few decisions", async () => {
    const result = await runPolicyCli(deps, "policy-exam", []);
    const expected = runLiveExam();
    expect(result.exitCode).toBe(expected.passed ? 0 : expected.enough ? 1 : 2);
    expect(result.stdout).toContain(expected.verdict);
    expect(result.stdout).toContain("in-sample, not evidence");
    expect(store.get(EXAM_RESULT_KEY)).toMatchObject({ accuracy: expected.accuracy, total: expected.total, fingerprint: expected.fingerprint, split: "exam-v2", enough: expected.enough });
  });

  it("exam-add appends an owner message, once; the store then feeds the gate", async () => {
    const input = { quote: "да, выкатывай сам", ref: "thr_x#12", at: Date.parse(POLICY.frozen_at) + 1000, descriptor: repair, expected: "night_decides", why: "he approved night repairs" };
    const first = await runPolicyCli(deps, "policy", ["exam-add", JSON.stringify(input)]);
    expect(JSON.parse(first.stdout!)).toMatchObject({ added: 1 });
    const again = await runPolicyCli(deps, "policy", ["exam-add", JSON.stringify(input)]);
    expect(JSON.parse(again.stdout!)).toMatchObject({ added: 0, skipped: 1 });
    const exported = await runPolicyCli(deps, "policy", ["exam-export"]);
    expect(JSON.parse(exported.stdout!).items).toHaveLength(EXAM_LIVE.items.length + 1);
    const verdict = await runPolicyCli(deps, "policy-exam", []);
    expect(verdict.stdout).toMatch(/NOT ENOUGH UNSEEN DECISIONS YET: 1 of 20/);
  });

  it("show / classify / morning / unknown", async () => {
    const show = await runPolicyCli(deps, "policy", ["show"]);
    expect(JSON.parse(show.stdout!)).toMatchObject({ owner_only: expect.arrayContaining(["judge_gates"]), standing_prohibitions: expect.arrayContaining(["never_acp_opencode"]), exam: { lastStoredRun: { split: "exam-v2" } } });
    const classified = await runPolicyCli(deps, "policy", ["classify", JSON.stringify({ kind: "project_delete" })]);
    expect(JSON.parse(classified.stdout!)).toMatchObject({ tier: "owner_only", authorized: { tier: "owner_only" } });
    expect((await runPolicyCli(deps, "policy", ["classify"])).exitCode).toBe(1);
    expect((await runPolicyCli(deps, "policy", ["classify", "{bad"])).exitCode).toBe(1);
    expect((await runPolicyCli(deps, "policy", ["exam-add"])).exitCode).toBe(1);
    expect((await runPolicyCli(deps, "policy", ["nope"])).exitCode).toBe(1);
  });
});
