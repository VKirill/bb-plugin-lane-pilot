import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXAM, EXAM_RESULT_KEY, authorize, examSchema, runExam, type Exam } from "../../src/rooms/policy/exam";
import { POLICY, classifyChange } from "../../src/rooms/policy/policy";
import { runPolicyCli } from "../../src/rooms/policy/cli";

const ROOT = join(__dirname, "..", "..");
const proof = { bench_subset_passed: true, auto_revertible: true };
const repair = { kind: "lp_fault_repair", files: ["src/rooms/relay/server/relay.ts"], attrs: proof };

describe("the split between the items the policy was written from and the exam", () => {
  it("no id is on both sides, and no design item sits in the exam", () => {
    const design = new Set(POLICY.design_items.map((item) => item.id));
    for (const item of EXAM.items) expect(design.has(item.id)).toBe(false);
    const designSources = new Set(POLICY.design_items.map((item) => item.source));
    for (const item of EXAM.items) if (item.source.type === "rule_proposal") expect(designSources.has(item.source.ref)).toBe(false);
    const designRuleIds = POLICY.design_items.flatMap((item) => item.source.match(/rule_[0-9a-f]{16}/g) ?? []);
    for (const item of EXAM.items) for (const id of designRuleIds) expect(item.source.ref.includes(id), `${item.id} is a design rule`).toBe(false);
  });

  it("memory exam items never cite a design memory file", () => {
    const designFiles = POLICY.design_items.map((item) => item.source.replace(/^memory\//, "")).filter((source) => source.endsWith(".md"));
    for (const item of EXAM.items.filter((i) => i.source.type === "memory")) expect(designFiles).not.toContain(item.source.ref);
  });

  it("rule-proposal exam items are dated on or after the time cut (2026-10-15), design items before it", () => {
    for (const item of EXAM.items.filter((i) => i.source.type === "rule_proposal")) expect(item.source.date >= "2026-10-15").toBe(true);
    for (const item of POLICY.design_items.filter((i) => /rule_proposal/.test(i.source))) expect(item.date < "2026-10-15").toBe(true);
  });

  it("every item has a unique id, a quote and a source", () => {
    expect(new Set(EXAM.items.map((item) => item.id)).size).toBe(EXAM.items.length);
    expect(() => examSchema.parse(JSON.parse(readFileSync(join(ROOT, "policy", "exam.json"), "utf8")))).not.toThrow();
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

  it("passes at the bar and fails under it", () => {
    const four = [item("x1", repair, "night_decides"), item("x2", { kind: "data_delete" }, "owner_only"), item("x3", { kind: "stage_add" }, "night_proposes"), item("x4", { kind: "teleport" }, "night_decides")];
    expect(runExam(POLICY, exam(...four)).passed).toBe(false); // 3/4 = 0.75
    expect(runExam(POLICY, exam(...four.slice(0, 3))).passed).toBe(true);
  });

  it("the fingerprint follows the policy and the items", () => {
    const base = runExam(POLICY, exam(item("x1", repair, "night_decides"))).fingerprint;
    expect(runExam(POLICY, exam(item("x1", repair, "night_proposes"))).fingerprint).not.toBe(base);
    const changed = JSON.parse(JSON.stringify(POLICY)) as typeof POLICY;
    changed.night_decides.pop();
    expect(runExam(changed, exam(item("x1", repair, "night_decides"))).fingerprint).not.toBe(base);
  });
});

describe("authorize: night_decides takes effect only while the exam passes", () => {
  const passing: Exam = { version: 1, labelling: {}, items: [{ id: "x1", source: { type: "memory", ref: "x.md", date: "2026-01-01" }, quote: "q", descriptor: repair, expected: "night_decides", strength: "strong", why: "w" }] };
  const failing: Exam = { ...passing, items: [{ ...passing.items[0]!, expected: "owner_only" }] };

  it("decides when the exam passes", () => {
    expect(authorize(repair, { exam: passing })).toMatchObject({ tier: "night_decides", degraded: false });
  });

  it("degrades to night_proposes when it fails, and says why", () => {
    const answer = authorize(repair, { exam: failing });
    expect(answer).toMatchObject({ requested: "night_decides", tier: "night_proposes", degraded: true });
    expect(answer.reason).toMatch(/degraded.*exam scored 0/);
  });

  it("never loosens the other tiers", () => {
    expect(authorize({ kind: "data_delete" }, { exam: passing }).tier).toBe("owner_only");
    expect(authorize({ kind: "stage_add" }, { exam: failing })).toMatchObject({ tier: "night_proposes", degraded: false });
  });

  it("the committed exam: the verdict follows the stored record", () => {
    const record = JSON.parse(readFileSync(join(ROOT, "policy", "exam-result.json"), "utf8")) as { passed: boolean };
    expect(authorize(repair).degraded).toBe(!record.passed);
    expect(classifyChange(repair)).toBe("night_decides");
  });
});

describe("the recorded result matches the current policy and exam", () => {
  it("policy/exam-result.json is fresh (rerun scripts/policy-exam.ts --write after editing policy/ and show the owner)", () => {
    const record = JSON.parse(readFileSync(join(ROOT, "policy", "exam-result.json"), "utf8")) as { fingerprint: string; accuracy: number; correct: number; total: number; passed: boolean };
    const now = runExam();
    expect({ fingerprint: record.fingerprint, accuracy: record.accuracy, correct: record.correct, total: record.total, passed: record.passed })
      .toEqual({ fingerprint: now.fingerprint, accuracy: now.accuracy, correct: now.correct, total: now.total, passed: now.passed });
  });
});

describe("bb lane-pilot policy-exam", () => {
  const store = new Map<string, unknown>();
  const deps = { db: { prepare: () => { throw new Error("not used"); } } as never, kv: { get: async (key: string) => store.get(key) as never, set: async (key: string, value: unknown) => { store.set(key, value); } }, now: () => 1_000 };

  it("reports the accuracy, stores the result and exits non-zero while it fails", async () => {
    const result = await runPolicyCli(deps, "policy-exam", []);
    const expected = runExam();
    expect(result.exitCode).toBe(expected.passed ? 0 : 1);
    expect(result.stdout).toContain(`accuracy ${expected.accuracy}`);
    expect(store.get(EXAM_RESULT_KEY)).toMatchObject({ at: 1_000, accuracy: expected.accuracy, total: expected.total, fingerprint: expected.fingerprint });
  });

  it("show / classify / morning / unknown", async () => {
    const show = await runPolicyCli(deps, "policy", ["show"]);
    expect(JSON.parse(show.stdout!)).toMatchObject({ owner_only: expect.arrayContaining(["judge_gates"]), exam: { lastStoredRun: { at: 1_000 } } });
    const classified = await runPolicyCli(deps, "policy", ["classify", JSON.stringify({ kind: "project_delete" })]);
    expect(JSON.parse(classified.stdout!)).toMatchObject({ tier: "owner_only", authorized: { tier: "owner_only", degraded: false } });
    expect((await runPolicyCli(deps, "policy", ["classify"])).exitCode).toBe(1);
    expect((await runPolicyCli(deps, "policy", ["classify", "{bad"])).exitCode).toBe(1);
    expect((await runPolicyCli(deps, "policy", ["nope"])).exitCode).toBe(1);
  });
});
