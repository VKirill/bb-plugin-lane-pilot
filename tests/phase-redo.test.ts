import { describe, expect, it } from "vitest";
import { acceptanceCommands, issuable, nextAction, pieceProblems, pieceSha, type Phase, type PlanItem, type TaskFact } from "../src/rooms/phase/logic";

const piece = (id: string, task: Record<string, unknown> = {}): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" },
  task: { id, owns_paths: ["src/**"], verification: [{ command: "node --test tests/a.test.js" }], acceptance: ["works"], ...task } });
const accepted = (ids: string[]) => new Map<string, TaskFact>(ids.map((id) => [id, { taskId: id, state: "accepted", planFact: "passed", verification: "passed", codeCritique: null }]));

describe("a piece whose contract changed is issued again", () => {
  it("only the changed piece goes again; an unchanged one keeps its work", () => {
    const a = piece("a"), b = piece("b");
    const prints = { a: pieceSha(a), b: pieceSha(b) };
    expect(issuable([a, b], { a: "a", b: "b" }, accepted(["a", "b"]), () => true, prints)).toEqual([]);
    const a2 = piece("a", { verification: [{ command: "npm test" }] });
    expect(issuable([a2, b], { a: "a", b: "b" }, accepted(["a", "b"]), () => true, prints).map((item) => item.id)).toEqual(["a"]);
  });
  it("a piece issued before the prints existed is not issued again", () => {
    expect(issuable([piece("a")], { a: "a" }, accepted(["a"]))).toEqual([]);
  });
});

describe("an acceptance line that names a command", () => {
  it("finds the command written plainly or in a code span", () => {
    expect(acceptanceCommands("The three notes test files are appended to the npm test script and npm test is green")).toEqual(["npm test"]);
    expect(acceptanceCommands("`node scripts/notes.js list` prints the note")).toEqual(["node scripts/notes.js list"]);
    expect(acceptanceCommands("README has a section «Заметки»")).toEqual([]);
  });
  it("must be a verification command of the contract", () => {
    const bad = piece("notes", { acceptance: ["npm test is green"], verification: [{ command: "node --test tests/notes/*.test.js" }] });
    expect(pieceProblems(bad).join(" ")).toMatch(/names `npm test`, which is not a verification command/);
    const good = piece("notes", { acceptance: ["npm test is green"], verification: [{ command: "npm test" }] });
    expect(pieceProblems(good)).toEqual([]);
  });
});

describe("the next action", () => {
  const phase = (record: Record<string, unknown>, stage: string): Phase => ({ id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "G", stage, state: "active",
    record: { plan: { items: [piece("a")] }, ...record }, edition: 1, createdAt: 1, updatedAt: 1 }) as unknown as Phase;
  it("after a failed verdict sends the PM to planning, not back to execution", () => {
    const next = nextAction(phase({ verification: { verdict: { state: "failed", detail: "a: plan-fact failed", inputSha: "x".repeat(64), at: 1, mainSha: null } } }, "verification"), accepted(["a"]));
    expect(next.text).toMatch(/return the phase to planning/);
    expect(next.text).toMatch(/same verdict/);
  });
  it("names the stop when nothing changed since the failed verdict", () => {
    const next = nextAction(phase({ execution: { issued: { a: "a" }, unchanged: { inputSha: "y".repeat(64), detail: "a: plan-fact failed" } } }, "execution"), accepted(["a"]));
    expect(next).toMatchObject({ waitsForPm: true });
    expect(next.text).toMatch(/nothing changed since the verification failed/);
  });
});

describe("a wave that is in with a failing line", () => {
  it("is named to the PM instead of «Lane Pilot issues the next wave»", () => {
    const items = [piece("a"), { ...piece("b"), wave: 2 }];
    const phase = { id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "G", stage: "execution", state: "active", edition: 1, createdAt: 1, updatedAt: 1,
      record: { plan: { items }, waveReview: true, execution: { issued: { a: "a.2" }, waves: { "1": { packageSha: "p".repeat(64), at: 1, lines: [{ id: "promises_proved", ok: false, detail: "plan-fact failed: a" }] } } } } } as unknown as Phase;
    const next = nextAction(phase, accepted(["a"]));
    expect(next).toMatchObject({ waitsForPm: true });
    expect(next.text).toMatch(/wave 1 is in, but promises_proved \(plan-fact failed: a\)/);
  });
});

describe("a wave whose review failed", () => {
  it("holds the phase with the review's words", () => {
    const phase = { id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "G", stage: "execution", state: "active", edition: 1, createdAt: 1, updatedAt: 1,
      record: { plan: { items: [piece("a")] }, waveReview: true, execution: { issued: { a: "a" }, waves: { "1": { packageSha: "p".repeat(64), at: 1, lines: [{ id: "pieces_accepted", ok: true, detail: "" }],
        review: { state: "failed", by: "lp.review", summary: "the CLI swallows errors", at: 1 } } } } } } as unknown as Phase;
    const next = nextAction(phase, accepted(["a"]));
    expect(next).toMatchObject({ waitsForPm: true });
    expect(next.text).toMatch(/review of wave 1 by another model failed \(the CLI swallows errors\)/);
  });
});
