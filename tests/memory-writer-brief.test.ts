import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBED_DIM,
  memoryContext,
  parseMemorySettings,
  rememberQueryVector,
  storeMemoryRecords,
  storeVectors,
  type MemoryRecord,
} from "../packages/memory-core/src";
import { taskV2Schema } from "../src/rooms/contracts";
import {
  compareRulerArms,
  evaluateWorkingVsHeldOut,
  parseRuler,
  runRuler,
  type RulerOptions,
} from "../src/rooms/memory-eval/server/services/ruler";
import {
  explicitMemorySearch,
  mixWriterMemory,
  pmMemoryContext,
  setEmbedder,
  setMemoryJudge,
  writerMemoryPicks,
} from "../src/rooms/memory/server";
import { migrations, openDatabase } from "../src/rooms/plugin-db";
import { writerKnowledge } from "../src/rooms/writer/server/index";

const limits = {
  sourceSha256: "a".repeat(64),
  audience: "subagent" as const,
  coreBudget: 99_999,
  noteBudget: 99_999,
  indexBudget: 999_999,
};

const axis = (i: number, j = i, mix = 0) => {
  const v = new Float32Array(EMBED_DIM);
  v[i] = 1 - mix;
  v[j] += mix;
  return v;
};

const makeTask = (owns: string[] = ["apps/api/orders/handler.ts"]) =>
  taskV2Schema.parse({
    schema_version: 2,
    id: "task_mem_brief",
    title: "Fix order locking timeout",
    risk: "low",
    lane: "writer",
    project_cwd: "/tmp/repo",
    read_first: [],
    interfaces: [],
    invariants: [],
    out_of_scope: [],
    expected_outputs: owns,
    owns_paths: owns,
    never_touch: [],
    depends_on: [],
    objective: "Prevent concurrent workers from double-processing orders",
    acceptance: ["orders use advisory locks"],
    verify: "none",
    verification: [],
  });

afterEach(() => {
  setMemoryJudge(null);
  setEmbedder(null);
});

describe("writer brief memory retrieval (Task 27)", () => {
  it("delivers a gold note that does not name the task folder via meaning search + judge and logs sources", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const [goldId] = storeMemoryRecords(db, {
      projectId: "P",
      ...limits,
      entries: [
        {
          kind: "note",
          content: "Production runs no Redis: advisory locks in Postgres serialize checkout jobs.",
          concepts: ["locking", "postgres"],
        },
      ],
    }).insertedIds;
    const [folderId] = storeMemoryRecords(db, {
      projectId: "P",
      ...limits,
      entries: [
        {
          kind: "note",
          content: "apps/api/orders/handler.ts parses request headers before dispatching.",
          concepts: ["orders"],
        },
      ],
    }).insertedIds;
    const [coreId] = storeMemoryRecords(db, {
      projectId: "P",
      ...limits,
      entries: [
        {
          kind: "core",
          content: "Conventions: use strict TypeScript and named exports.",
          concepts: ["conventions"],
        },
      ],
    }).insertedIds;

    storeVectors(db, [
      { id: goldId!, projectId: "P", content: "g", vector: axis(0) },
      { id: folderId!, projectId: "P", content: "f", vector: axis(1, 0, 0.2) },
      { id: coreId!, projectId: "P", content: "c", vector: axis(2) },
    ]);
    setEmbedder(async (texts) => texts.map(() => axis(0)));
    setMemoryJudge(async ({ candidates }) => ({
      chosen: candidates.filter((c) => c.id === goldId),
      receipt: {
        model: "gemini-3.8-flash",
        candidates: candidates.map((c) => c.id),
        chosen: [goldId!],
        latencyMs: 10,
        tokensIn: 50,
        tokensOut: 5,
      },
    }));

    const logs: string[] = [];
    const task = makeTask(["apps/api/orders/handler.ts"]);
    const knowledge = await writerKnowledge(
      {
        db,
        host: { call: async () => { throw new Error("unused"); } } as never,
        chainForRun: async () => [],
        log: (line) => logs.push(line),
      },
      {
        projectId: "P",
        runId: "run_1",
        hostId: "local",
        task,
        memorySettings: parseMemorySettings({ "memory.pack_mode": "off" }),
      },
    );

    expect(knowledge.mixed.ids).toEqual([folderId, goldId, coreId]);
    expect(knowledge.mixed.text).toContain("advisory locks in Postgres");
    expect(knowledge.mixed.sources).toEqual({
      folder: [folderId],
      meaning: [goldId],
      tagged: [],
      core: [coreId],
    });
    const briefLog = logs.find((line) => line.startsWith("writer.brief memory "));
    expect(briefLog).toBeDefined();
    expect(briefLog).toContain(`folder=[${folderId}]`);
    expect(briefLog).toContain(`meaning=[${goldId}]`);
    expect(briefLog).toContain(`core=[${coreId}]`);
  });

  it("delivers meaning-search notes without a judge when cosine clears DENSE_PREFILTER, while reserving one slot for core", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const [m1, m2, m3] = storeMemoryRecords(db, {
      projectId: "P",
      ...limits,
      entries: [
        { kind: "note", content: "Advisory locks serialize background jobs cleanly.", concepts: ["jobs"] },
        { kind: "note", content: "Retry queue waits fifteen seconds between bursts.", concepts: ["retry"] },
        { kind: "note", content: "Dead letter rows keep their original payload.", concepts: ["dlq"] },
      ],
    }).insertedIds;
    const [coreId] = storeMemoryRecords(db, {
      projectId: "P",
      ...limits,
      entries: [{ kind: "core", content: "Always keep migrations append-only.", concepts: ["migrations"] }],
    }).insertedIds;
    storeVectors(db, [
      { id: m1!, projectId: "P", content: "1", vector: axis(0) },
      { id: m2!, projectId: "P", content: "2", vector: axis(0, 1, 0.1) },
      { id: m3!, projectId: "P", content: "3", vector: axis(0, 1, 0.2) },
      { id: coreId!, projectId: "P", content: "c", vector: axis(2) },
    ]);
    const query = "How are concurrent background jobs serialized?";
    rememberQueryVector(query, axis(0));

    const mixed = mixWriterMemory(db, {
      projectId: "P",
      query,
      task: { owns_paths: ["src/unrelated/worker.ts"], read_first: [] },
      searchEngine: "auto",
      personalBot: "",
      ruleMemoryIds: new Set(),
    });
    expect(mixed.ids).toEqual([m1, m2, coreId]);
    expect(mixed.sources.meaning).toEqual([m1, m2]);
    expect(mixed.sources.core).toEqual([coreId]);
  });

  it("preserves reranker order when memory.judge.mode=rerank in the writer brief", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const [n1, n2] = storeMemoryRecords(db, {
      projectId: "P",
      ...limits,
      entries: [
        { kind: "note", content: "First cosine note about checkout.", concepts: ["checkout"] },
        { kind: "note", content: "Second cosine note with exact lock guidance.", concepts: ["checkout"] },
      ],
    }).insertedIds;
    storeVectors(db, [
      { id: n1!, projectId: "P", content: "1", vector: axis(0) },
      { id: n2!, projectId: "P", content: "2", vector: axis(0, 1, 0.1) },
    ]);
    setEmbedder(async (texts) => texts.map(() => axis(0)));
    setMemoryJudge(async ({ candidates }) => {
      const reversed = [...candidates].reverse();
      return {
        chosen: reversed,
        receipt: {
          model: "sonnet",
          candidates: candidates.map((c) => c.id),
          chosen: reversed.map((c) => c.id),
          latencyMs: 12,
          tokensIn: 60,
          tokensOut: 6,
          mode: "rerank",
        },
      };
    });

    const knowledge = await writerKnowledge(
      {
        db,
        host: { call: async () => { throw new Error("unused"); } } as never,
        chainForRun: async () => [],
        log: () => {},
      },
      {
        projectId: "P",
        runId: "run_rerank",
        hostId: "local",
        task: makeTask(["src/unrelated/file.ts"]),
        memorySettings: parseMemorySettings({ "memory.judge.mode": "rerank", "memory.pack_mode": "off" }),
      },
    );
    expect(knowledge.mixed.ids).toEqual([n2, n1]);
  });

  it("does not deliver expired notes or notes whose verification check fails across delivery paths", async () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const [validId, expiredId, driftedId] = storeMemoryRecords(db, {
      projectId: "P",
      ...limits,
      now: now - 10_000,
      readFile: (path) => (path === "src/widget/app.ts" ? new TextEncoder().encode("v1") : null),
      entries: [
        { kind: "note", content: "Valid note for src/widget/stable.ts keeps port 3000.", concepts: ["widget"] },
        { kind: "note", content: "Expired note for src/widget/old.ts expires soon.", concepts: ["widget"], validUntil: now - 1_000 },
        { kind: "note", content: "Drifted note for src/widget/app.ts relies on old v1.", concepts: ["widget"] },
      ],
    }).insertedIds;

    // Force valid_until check at retrieval time even before a write-door expiry sweep runs.
    const readFile = (path: string) => (path === "src/widget/app.ts" ? new TextEncoder().encode("v2") : null);
    const verifyNote = (record: MemoryRecord) => !record.content.includes("old v1");

    const writerMix = mixWriterMemory(db, {
      projectId: "P",
      query: "widget port",
      task: { owns_paths: ["src/widget/stable.ts", "src/widget/old.ts", "src/widget/app.ts"], read_first: [] },
      searchEngine: "fts5",
      personalBot: "",
      ruleMemoryIds: new Set(),
      now,
      readFile,
      verifyNote,
    });
    expect(writerMix.ids).toEqual([validId]);
    expect(writerMix.text).not.toContain("Expired note");
    expect(writerMix.text).not.toContain("Drifted note");

    const searched = await explicitMemorySearch(db, {
      projectId: "P",
      query: "widget",
      limit: 10,
      memory: parseMemorySettings({ "memory.judge.enabled": false }),
      now,
      readFile,
      verifyNote,
    });
    expect(searched.records.map((r) => r.id)).toEqual([validId]);

    const pmPacked = pmMemoryContext(db, "P", parseMemorySettings({}), "widget", [], "pm", null, { now, verifyNote });
    expect(pmPacked.records.map((r) => r.id)).toEqual([validId]);

    // Direct pure helpers also drop expired or check-failed notes.
    const directPicks = writerMemoryPicks(
      [
        { id: "ok", content: "src/widget/a.ts stays", concepts: [], validUntil: now + 60_000, verify: () => true },
        { id: "exp", content: "src/widget/a.ts expired", concepts: [], validUntil: now - 1 },
        { id: "bad", content: "src/widget/a.ts check failed", concepts: [], checkPassed: false },
        { id: "fn_bad", content: "src/widget/a.ts fn failed", concepts: [], verify: () => false },
      ],
      { owns_paths: ["src/widget/a.ts"], read_first: [] },
      [],
      { now },
    );
    expect(directPicks.map((n) => n.id)).toEqual(["ok"]);

    const directContext = memoryContext(
      [
        { id: validId!, projectId: "P", personalBot: "", kind: "note", content: "widget active", concepts: [], sourceSha256: "a", createdAt: 1, validUntil: now + 60_000 },
        { id: expiredId!, projectId: "P", personalBot: "", kind: "note", content: "widget expired", concepts: [], sourceSha256: "a", createdAt: 1, validUntil: now - 1 },
        { id: driftedId!, projectId: "P", personalBot: "", kind: "note", content: "widget failed", concepts: [], sourceSha256: "a", createdAt: 1 },
      ],
      "widget",
      500,
      { now, verifyNote: (r) => r.id !== driftedId },
    );
    expect(directContext.records.map((r) => r.id)).toEqual([validId]);
  });

  it("evaluates ruler arms with paired bootstrap intervals, logs memory.arm, and rejects working-set overfit", async () => {
    const db = new Database(":memory:");
    for (const stmt of migrations) db.exec(stmt);
    const [goldId] = storeMemoryRecords(db as never, {
      projectId: "P",
      ...limits,
      entries: [
        {
          kind: "note",
          content: "Advisory locks in Postgres serialize checkout jobs without Redis.",
          concepts: ["checkout", "locking"],
        },
      ],
    }).insertedIds;
    storeVectors(db as never, [{ id: goldId!, projectId: "P", content: "g", vector: axis(0) }]);
    const buffer = db.serialize();
    db.close();

    const workingQs = parseRuler(
      [
        { qid: "w1", project: "P", query: "How are concurrent checkout jobs serialized?", label: "answerable", gold: [goldId], paths: { owns_paths: ["src/orders/run.ts"], read_first: [] } },
        { qid: "w2", project: "P", query: "Which color is the marketing header?", label: "unanswerable", gold: [] },
      ].map((r) => JSON.stringify(r)).join("\n"),
    );
    const heldOutQs = parseRuler(
      [
        { qid: "h1", project: "P", query: "How are concurrent checkout jobs serialized?", label: "answerable", gold: [goldId], paths: { owns_paths: ["src/orders/run.ts"], read_first: [] } },
        { qid: "h2", project: "P", query: "Which font does the invoice PDF use?", label: "unanswerable", gold: [] },
      ].map((r) => JSON.stringify(r)).join("\n"),
    );

    const logs: string[] = [];
    const common: RulerOptions = {
      vectorMode: "all",
      doorLock: "off",
      judgeMode: "filter",
      pinned: false,
      judge: "on",
      scope: "project",
      runs: 1,
      limit: 5,
      parallel: 1,
      embedder: async (texts) => texts.map((t) => (t.includes("serialized") ? axis(0) : axis(3))),
      makeJudge: () => async ({ candidates }) => ({
        chosen: candidates.filter((c) => c.id === goldId),
        receipt: { model: "flash", candidates: candidates.map((c) => c.id), chosen: [goldId!], latencyMs: 1, tokensIn: 10, tokensOut: 2 },
      }),
      log: (line) => logs.push(line),
    };

    const control = await runRuler(() => new Database(buffer), heldOutQs, { ...common, path: "none", arm: "control" });
    const writerArm = await runRuler(() => new Database(buffer), heldOutQs, { ...common, path: "writer", arm: "writer-meaning" });
    expect(logs.some((l) => l.startsWith("INFO memory.arm path=writer:project hit3=100.0% none_ok=100.0%"))).toBe(true);

    const cmp = compareRulerArms(control.scopes[0]!, writerArm.scopes[0]!);
    expect(cmp.hit3.mean).toBe(1);
    expect(cmp.noneOk.mean).toBe(0);
    expect(cmp.adopt).toBe(true);

    // Working-set win + held-out loss -> WARN overfit rejected.
    const workingControl = await runRuler(() => new Database(buffer), workingQs, { ...common, path: "none" });
    const workingWin = await runRuler(() => new Database(buffer), workingQs, { ...common, path: "writer" });
    const overfitLogs: string[] = [];
    const verdict = evaluateWorkingVsHeldOut({
      arm: "overfit-arm",
      path: "writer",
      workingControl: workingControl.scopes[0]!,
      workingArm: workingWin.scopes[0]!,
      heldOutControl: control.scopes[0]!,
      heldOutArm: control.scopes[0]!,
      log: (line) => overfitLogs.push(line),
    });
    expect(verdict.adopt).toBe(false);
    expect(verdict.reason).toBe("overfit");
    expect(overfitLogs.some((l) => l.startsWith("WARN memory.arm overfit rejected arm=overfit-arm"))).toBe(true);
  });
});
