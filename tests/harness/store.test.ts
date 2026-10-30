import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRun, createTask, openDatabase, saveStageReceipt } from "../../src/rooms/storage/database";
import {
  activeHarness, assignAttemptHarness, getHarness, insertHarness, listExperiences, saveExperience, setHarnessState, teachingKeys, trialAttempts, trialHarness,
} from "../../src/rooms/harness/server/store";

const DAY = 86_400_000;
const NOW = 5_000 * DAY;
const WRITER = "codex/gpt-6-luna";

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "proj");
  return db;
}

type Db = ReturnType<typeof setup>;
let n = 0;
function attempt(db: Db, input: { id?: string; task: string; state?: string; no?: number; at: number; run?: string }): string {
  const id = input.id ?? `att${++n}`;
  db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, input.run ?? "run1", input.task, input.state ?? "accepted", input.no ?? 1, input.at, input.at);
  return id;
}
const task = (db: Db, id: string, area = "billing") => createTask(db, { id, runId: "run1", kind: "bb", contract: { area } });

describe("harness store: trees", () => {
  it("creates an empty base on first use and returns the same row afterwards", () => {
    const db = setup();
    const first = activeHarness(db, "proj", "billing", WRITER, NOW);
    expect(first.state).toBe("base");
    expect(first.tree).toEqual({});
    expect(first.version).toBe(1);
    expect(first.parentId).toBeNull();
    const second = activeHarness(db, "proj", "billing", WRITER, NOW + 1000);
    expect(second.id).toBe(first.id);
    expect(db.prepare("SELECT count(*) AS c FROM lane_pilot_harness").get()).toEqual({ c: 1 });
  });

  it("increments the version per (project, area, writerKey) and reads the tree back", () => {
    const db = setup();
    const base = activeHarness(db, "proj", "billing", WRITER, NOW);
    const v2 = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: { "always-on.md": "one" }, state: "candidate", createdBy: "editor", parentId: base.id, notes: "n", now: NOW });
    const v3 = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: { "always-on.md": "two" }, state: "candidate", createdBy: "editor", parentId: base.id, now: NOW });
    const other = insertHarness(db, { projectId: "proj", area: "orders", writerKey: WRITER, tree: {}, state: "base", createdBy: "system", parentId: null, now: NOW });
    const otherWriter = insertHarness(db, { projectId: "proj", area: "billing", writerKey: "*", tree: {}, state: "base", createdBy: "system", parentId: null, now: NOW });
    expect([base.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(other.version).toBe(1);
    expect(otherWriter.version).toBe(1);
    const read = getHarness(db, v2.id)!;
    expect(read.tree).toEqual({ "always-on.md": "one" });
    expect(read.parentId).toBe(base.id);
    expect(read.notes).toBe("mechanisms: always-on edits only; 1 always-on tokens\nn");
    expect(read.fingerprint).toBeTruthy();
    expect(getHarness(db, "missing")).toBeNull();
  });

  it("returns the adopted tree from activeHarness once a candidate is adopted", () => {
    const db = setup();
    const base = activeHarness(db, "proj", "billing", WRITER, NOW);
    const cand = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: { "always-on.md": "x" }, state: "candidate", createdBy: "editor", parentId: base.id, now: NOW });
    expect(activeHarness(db, "proj", "billing", WRITER, NOW).id).toBe(base.id);
    setHarnessState(db, cand.id, "adopted", "better", NOW + 10);
    const active = activeHarness(db, "proj", "billing", WRITER, NOW + 20);
    expect(active.id).toBe(cand.id);
    expect(active.state).toBe("adopted");
    expect(active.reason).toBe("better");
    expect(active.decidedAt).toBe(NOW + 10);
  });

  it("finds the trial and sets trialStartedAt when a tree enters trial", () => {
    const db = setup();
    const base = activeHarness(db, "proj", "billing", WRITER, NOW);
    expect(trialHarness(db, "proj", "billing", WRITER)).toBeNull();
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: { "memory.md": "- a" }, state: "trial", createdBy: "editor", parentId: base.id, now: NOW });
    expect(trial.trialStartedAt).toBe(NOW);
    expect(trialHarness(db, "proj", "billing", WRITER)?.id).toBe(trial.id);
    expect(trialHarness(db, "proj", "orders", WRITER)).toBeNull();
    setHarnessState(db, trial.id, "retired", "worse", NOW + 5);
    expect(trialHarness(db, "proj", "billing", WRITER)).toBeNull();
  });
});

describe("harness store: trial attempts", () => {
  it("returns only the arms' attempts created after the trial started, with blocking findings from the critique receipt", () => {
    const db = setup();
    const base = activeHarness(db, "proj", "billing", WRITER, NOW);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: { "always-on.md": "x" }, state: "trial", createdBy: "editor", parentId: base.id, now: NOW });
    for (const t of ["tNew", "tOld", "tBefore", "tOther", "tNone"]) task(db, t);
    const aNew = attempt(db, { task: "tNew", at: NOW + 10 });
    const aOld = attempt(db, { task: "tOld", at: NOW + 20, state: "blocked", no: 2 });
    const aBefore = attempt(db, { task: "tBefore", at: NOW - 10 });
    const aOther = attempt(db, { task: "tOther", at: NOW + 30 });
    attempt(db, { task: "tNone", at: NOW + 40 });
    assignAttemptHarness(db, aNew, trial.id, "new");
    assignAttemptHarness(db, aOld, base.id, "old");
    assignAttemptHarness(db, aBefore, trial.id, "new");
    assignAttemptHarness(db, aOther, "hrn_unrelated", "old");

    saveStageReceipt(db, {
      runId: "run1", taskId: "tNew", stageId: "code-critique", contractVersion: 1, state: "passed", inputSha256: "a".repeat(64), outputSha256: null, attempt: 0,
      providerId: null, model: null, threadId: null, reason: null, updatedAt: NOW + 15,
      result: { decision: "changes_requested", summary: "", findings: [{ severity: "blocking" }, { severity: "info" }] },
    });

    const rows = trialAttempts(db, trial);
    expect(rows.map((r) => r.attemptId)).toEqual([aNew, aOld]);
    expect(rows[0]).toMatchObject({ arm: "new", taskId: "tNew", state: "accepted", attemptNo: 1, blockingFindings: 1 });
    expect(rows[1]).toMatchObject({ arm: "old", taskId: "tOld", state: "blocked", attemptNo: 2, blockingFindings: 0 });
  });

  it("does not match an arm with the wrong tree id", () => {
    const db = setup();
    const base = activeHarness(db, "proj", "billing", WRITER, NOW);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: {}, state: "trial", createdBy: "editor", parentId: base.id, now: NOW });
    task(db, "t1");
    const swapped = attempt(db, { task: "t1", at: NOW + 1 });
    assignAttemptHarness(db, swapped, base.id, "new"); // base tree in arm new
    expect(trialAttempts(db, trial)).toEqual([]);
  });
});

describe("harness store: experiences", () => {
  it("saves, upserts and lists experiences of an area", () => {
    const db = setup();
    const base = activeHarness(db, "proj", "billing", WRITER, NOW);
    const cand = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: { "always-on.md": "x" }, state: "adopted", createdBy: "editor", parentId: base.id, now: NOW });
    const elsewhere = insertHarness(db, { projectId: "proj", area: "orders", writerKey: WRITER, tree: {}, state: "base", createdBy: "system", parentId: null, now: NOW });
    saveExperience(db, { harnessId: cand.id, editsMd: "| edit |", cue: "cue", lesson: "lesson", evidence: "ev", confidence: "high", ruleId: null, now: NOW + 1 });
    saveExperience(db, { harnessId: elsewhere.id, editsMd: "other", cue: null, lesson: null, evidence: null, confidence: null, ruleId: null, now: NOW + 2 });
    saveExperience(db, { harnessId: cand.id, editsMd: "| edit v2 |", cue: "cue", lesson: "lesson2", evidence: "ev", confidence: "high", ruleId: "rule1", now: NOW + 3 });
    const list = listExperiences(db, "proj", "billing");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ harnessId: cand.id, editsMd: "| edit v2 |", lesson: "lesson2", ruleId: "rule1" });
    expect(list[0].harness.id).toBe(cand.id);
    expect(listExperiences(db, "proj", "nothing")).toEqual([]);
  });
});

describe("harness store: teachingKeys", () => {
  const reasoning = (db: Db, attemptId: string, writerKey: string) =>
    db.prepare("INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES (?,?)").run(attemptId, JSON.stringify({ attemptId, dispatchContext: { writerKey } }));

  it("groups by the contract area and the dispatch writer key, skips drills, and honours minAttempts", () => {
    const db = setup();
    for (let i = 0; i < 3; i++) { task(db, `b${i}`, "billing"); reasoning(db, attempt(db, { task: `b${i}`, at: NOW + i }), WRITER); }
    for (let i = 0; i < 2; i++) { task(db, `o${i}`, "orders"); attempt(db, { task: `o${i}`, at: NOW + 10 + i }); }
    for (let i = 0; i < 4; i++) { task(db, `drill-${i}`, "billing"); reasoning(db, attempt(db, { task: `drill-${i}`, at: NOW + 20 + i }), WRITER); }
    task(db, "run-x", "billing");
    attempt(db, { task: "run-x", at: NOW + 30, state: "running" });
    task(db, "old", "billing");
    attempt(db, { task: "old", at: NOW - 100 });

    expect(teachingKeys(db, "proj", NOW, 1)).toEqual([
      { area: "orders", writerKey: "*", attempts: 2 },
      { area: "billing", writerKey: WRITER, attempts: 3 },
    ]);
    expect(teachingKeys(db, "proj", NOW, 3)).toEqual([{ area: "billing", writerKey: WRITER, attempts: 3 }]);
    expect(teachingKeys(db, "proj", NOW, 4)).toEqual([]);
    expect(teachingKeys(db, "other-project", NOW, 1)).toEqual([]);
  });
});
