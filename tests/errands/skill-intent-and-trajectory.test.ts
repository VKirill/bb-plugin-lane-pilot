import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import { WorkflowEngine, loadWorkflowStore, parseWorkflow, registerPureActions } from "@lane-pilot/workflow-engine";
import type { GoalAudit, RunGoal, Workflow } from "@lane-pilot/workflow-engine";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { migrations } from "../../src/rooms/migrations";
import {
  SKILL_DOMAIN_SYNONYMS,
  TRAJECTORY_DELTA_TABLE,
  episodeSkills,
  hasExplicitSkillIntent,
  resolveSkillIntent,
  trajectoryDeltaMigrations,
  type SkillCatalogItem,
  type TrajectoryInterventionKind,
} from "../../src/rooms/errands";
import {
  listUnprocessedTrajectoryDeltas,
  markTrajectoryDeltasProcessed,
  mountErrands,
  recordTrajectoryDelta,
} from "../../src/rooms/errands/server";
import { registerQueueTool } from "../../src/rooms/tasks/server";
import { answerWorkflowQuestion, noteHumanAnswer } from "../../src/rooms/workflow/server";
import { amendGoalsTool, type WorkflowToolDeps } from "../../src/rooms/workflow/server/handlers/workflow-tools";
import { registerHumanForm } from "../../src/rooms/workflow/server/services/workflow-human-form";
import type { WorkflowAgents } from "../../src/rooms/workflow/server/services/workflow-agent";
import { BUILTIN_SOURCES, builtinWorkflow } from "../../src/rooms/workflow/builtin";
import type { ChainRuntime, ServerCore } from "../../src/rooms/contracts/server";
import type { OwnerAnswer } from "../../src/rooms/relay/server";
import migrationLock from "../fixtures/migrations.lock.json";

const CATALOG: readonly SkillCatalogItem[] = [
  {
    name: "ru-text",
    description: "Russian copywriting, editorial tone, headlines and text review",
    tags: ["copywriting", "editorial", "ru"],
    triggers: ["русский текст", "копирайтинг"],
  },
  {
    name: "copywriting-pro",
    description: "Продающие тексты, слоганы, заголовки, копирайтинг и редактура",
    tags: ["copywriting", "editorial"],
  },
  {
    name: "seo-audit",
    description: "Technical SEO audit, meta tags, schema, sitemap and search snippets",
    tags: ["seo", "search"],
    triggers: ["проверь seo", "сниппет"],
  },
  {
    name: "impeccable-ui",
    description: "Design, layout, visual typography, styling and landing review",
    tags: ["design", "layout", "ui"],
    triggers: ["ревью вёрстки", "дизайн"],
  },
  {
    name: "browser-qa",
    description: "Browser QA verification, regression checks and layout review",
    tags: ["qa", "browser"],
  },
  {
    name: "architecture-guard",
    description: "Check module boundaries, architecture contracts and database schema",
    tags: ["architecture", "module", "boundary"],
  },
  {
    name: "sql-ops",
    description: "SQLite maintenance, vacuum and backup operations",
    tags: ["ops", "sqlite"],
  },
];

const toolCall = (seq: number, tool: string, args: unknown) => ({
  type: "item/completed",
  seq,
  data: {
    item: {
      type: "toolCall",
      server: "bb",
      tool,
      arguments: args,
      status: "completed",
    },
  },
});

afterEach(() => {
  forgetSecrets();
});

describe("SkillIntentResolver", () => {
  it("resolves Russian copywriting requests including typos to copywriting skills only and logs INFO", () => {
    expect(Object.keys(SKILL_DOMAIN_SYNONYMS)).toEqual(
      expect.arrayContaining(["copywriting", "seo", "design", "qa", "architecture"]),
    );
    expect(hasExplicitSkillIntent("задействуй скиллы копирайтинга")).toBe(true);
    expect(hasExplicitSkillIntent("задейстувуй скиллы копирайтинга")).toBe(true);
    expect(hasExplicitSkillIntent("use the skills for SEO")).toBe(true);
    expect(hasExplicitSkillIntent("просто поправь отступ")).toBe(false);

    for (const phrase of [
      "задействуй скиллы копирайтинга",
      "задейстувуй скиллы копирайтинга",
    ]) {
      const logs: string[] = [];
      const matches = resolveSkillIntent(phrase, CATALOG, { log: (m) => logs.push(m) });
      const names = matches.map((m) => m.name);

      expect(names).toEqual(expect.arrayContaining(["ru-text", "copywriting-pro"]));
      expect(names).not.toContain("sql-ops");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^INFO \[errands\.skillIntent\] resolved /);
      const payload = JSON.parse(logs[0]!.replace(/^INFO \[errands\.skillIntent\] resolved /, "")) as {
        count: number;
        skills: Array<{ name: string; score: number }>;
      };
      expect(payload.count).toBe(matches.length);
      expect(payload.skills.map((s) => s.name)).toEqual(names);
    }
  });

  it("resolves multi-domain Russian and English queries to copywriting, SEO, design/QA and architecture skills", () => {
    const multiMatches = resolveSkillIntent("проверь русский текст и SEO", CATALOG);
    const multiNames = multiMatches.map((m) => m.name);
    expect(multiNames).toEqual(expect.arrayContaining(["ru-text", "seo-audit"]));
    expect(multiNames).not.toContain("sql-ops");

    const layoutMatches = resolveSkillIntent("сделай ревью вёрстки", CATALOG);
    expect(layoutMatches.map((m) => m.name)).toEqual(
      expect.arrayContaining(["impeccable-ui", "browser-qa"]),
    );

    const archMatches = resolveSkillIntent("check module boundaries", CATALOG);
    expect(archMatches[0]?.name).toBe("architecture-guard");
    expect(archMatches.map((m) => m.name)).not.toContain("ru-text");
  });

  it("ranks exact skill name mentions first and strips scope prefixes", () => {
    const scopedCatalog: readonly SkillCatalogItem[] = [
      { name: "editorial-helper", description: "General copywriting helper", tags: ["copywriting"] },
      { name: "vechkasov:impeccable-ui", description: "Visual layout polish", tags: ["design"] },
    ];
    const matches = resolveSkillIntent("apply impeccable-ui for design review", scopedCatalog);
    expect(matches[0]?.name).toBe("impeccable-ui");
    expect(matches.every((m) => !m.name.includes(":"))).toBe(true);
  });

  it("logs DEBUG on empty match, masks registered secrets, and respects a warn log level", () => {
    const secret = "sk-live-secret-999";
    registerSecrets([secret]);

    const debugLogs: string[] = [];
    const emptyMatches = resolveSkillIntent(`unrelated token ${secret}`, CATALOG, {
      log: (m) => debugLogs.push(m),
    });
    expect(emptyMatches).toEqual([]);
    expect(debugLogs).toHaveLength(1);
    expect(debugLogs[0]).toMatch(/^DEBUG \[errands\.skillIntent\] resolved /);
    expect(debugLogs[0]).not.toContain(secret);
    const debugPayload = JSON.parse(debugLogs[0]!.replace(/^DEBUG \[errands\.skillIntent\] resolved /, "")) as {
      count: number;
      intent: string;
    };
    expect(debugPayload.count).toBe(0);
    expect(debugPayload.intent).not.toContain(secret);

    // The level comes in as a parameter: LOG_LEVEL is read once at the plugin entry (initRuntimeEnv), not per call.
    const suppressedLogs: string[] = [];
    const matched = resolveSkillIntent("задействуй скиллы копирайтинга", CATALOG, {
      log: (m) => suppressedLogs.push(m),
      logLevel: "warn",
    });
    expect(matched.length).toBeGreaterThan(0);
    expect(suppressedLogs).toEqual([]);
  });
});

describe("unoffered SKILL.md reads & direct skill calls", () => {
  it("records offered:false skills from SKILL.md reads and direct skill calls while ignoring bb:bash", () => {
    const logs: string[] = [];
    const events = [
      toolCall(1, "read", { path: "/workspace/vechkasov.ru/.agents/skills/impeccable-ui/SKILL.md" }),
      toolCall(2, "read", { path: "/workspace/vechkasov.ru/.agents/skills/ru-text/SKILL.md" }),
      toolCall(3, "skill", { id: "ru-text" }),
      toolCall(4, "bb:bash", { command: "npm run build" }),
    ];

    const skills = episodeSkills([], events, { log: (m) => logs.push(m) });

    expect(skills).toEqual([
      { name: "impeccable-ui", offered: false, read: true, used: false },
      { name: "ru-text", offered: false, read: true, used: true },
    ]);
    expect(skills.some((s) => s.name.includes("bash") || s.name === "bb")).toBe(false);
    expect(logs.some((line) => line.includes("[errands.skillIntent] unoffered_skills") && line.includes("impeccable-ui") && line.includes("ru-text"))).toBe(true);
  });
});

describe("lane_pilot_trajectory_delta & migrations.lock.json", () => {
  it("records, masks PII/secrets, deduplicates, rejects invalid deltas, lists and marks processed", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const secret = "sk-live-secret-999";
    registerSecrets([secret]);

    try {
      const logs: string[] = [];
      const warns: string[] = [];
      const baseInput = {
        projectId: "proj-1",
        threadId: "thr-1",
        workflowId: "errand",
        stageArchetype: "Design & Copy!",
        interventionKind: "skill_request" as const,
        rawSummary: `Задействуй скиллы копирайтинга, напиши owner@example.com или +7 999 123-45-67, ключ ${secret}`,
        catalog: CATALOG,
        now: 1_730_000_001_000,
        log: (m: string) => logs.push(m),
        warn: (m: string) => warns.push(m),
      };

      const first = recordTrajectoryDelta(db, baseInput);
      expect(first.status).toBe("recorded");
      expect(first.row).not.toBeNull();
      expect(first.row?.stageArchetype).toBe("design-copy");
      expect(first.row?.resolvedSkills).toEqual(expect.arrayContaining(["ru-text", "copywriting-pro"]));
      expect(first.row?.maskedSummary).toContain("[email]");
      expect(first.row?.maskedSummary).toContain("[phone]");
      expect(first.row?.maskedSummary).not.toContain("owner@example.com");
      expect(first.row?.maskedSummary).not.toContain("123-45-67");
      expect(first.row?.maskedSummary).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
      expect(logs.some((l) => l.startsWith("INFO [errands.trajectoryDelta] recorded "))).toBe(true);

      const dup = recordTrajectoryDelta(db, baseInput);
      expect(dup.status).toBe("duplicate");
      expect(dup.row?.id).toBe(first.row?.id);
      expect(logs.some((l) => l.startsWith("DEBUG [errands.trajectoryDelta] duplicate "))).toBe(true);

      const badKind = recordTrajectoryDelta(db, {
        projectId: "proj-1",
        interventionKind: "unknown_kind" as TrajectoryInterventionKind,
        rawSummary: `bad ${secret}`,
        warn: (m) => warns.push(m),
      });
      expect(badKind).toEqual({ status: "rejected", row: null, reason: "invalid_kind" });

      const emptySummary = recordTrajectoryDelta(db, {
        projectId: "proj-1",
        interventionKind: "rule_added",
        rawSummary: "   ",
        warn: (m) => warns.push(m),
      });
      expect(emptySummary).toEqual({ status: "rejected", row: null, reason: "empty_summary" });
      expect(warns.some((w) => w.startsWith("WARN [errands.trajectoryDelta] rejected "))).toBe(true);
      expect(warns.join("\n")).not.toContain(secret);

      const unaccepted = recordTrajectoryDelta(db, {
        projectId: "proj-1",
        interventionKind: "variant_selected",
        rawSummary: "Rejected variant B for hero section",
        ownerAccepted: false,
        now: 1_730_000_002_000,
      });
      expect(unaccepted.status).toBe("recorded");

      const otherProject = recordTrajectoryDelta(db, {
        projectId: "proj-2",
        interventionKind: "step_inserted",
        rawSummary: "Insert browser QA gate before deploy",
        now: 1_730_000_003_000,
      });
      expect(otherProject.status).toBe("recorded");

      const acceptedProj1 = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-1" });
      expect(acceptedProj1.map((r) => r.id)).toEqual([first.row!.id]);

      const allProj1 = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-1", onlyAccepted: false });
      expect(allProj1.map((r) => r.id)).toEqual([first.row!.id, unaccepted.row!.id]);

      const processedLogs: string[] = [];
      const marked = markTrajectoryDeltasProcessed(
        db,
        [first.row!.id],
        1_730_000_010_000,
        (m) => processedLogs.push(m),
      );
      expect(marked).toBe(1);
      expect(processedLogs).toHaveLength(1);
      expect(processedLogs[0]).toMatch(/^INFO \[errands\.trajectoryDelta\] processed /);

      expect(listUnprocessedTrajectoryDeltas(db, { projectId: "proj-1" })).toEqual([]);

      expect(() =>
        db.prepare(`DELETE FROM ${TRAJECTORY_DELTA_TABLE} WHERE id = ?`).run(first.row!.id),
      ).toThrow(/trajectory deltas are append-only/);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("matches trajectoryDeltaMigrations hashes in migrations and migrations.lock.json", () => {
    const lockHashes = migrationLock as string[];
    const migrationHashes = migrations.map((statement) =>
      createHash("sha256").update(statement).digest("hex"),
    );
    const deltaHashes = trajectoryDeltaMigrations.map((statement) =>
      createHash("sha256").update(statement).digest("hex"),
    );
    const startIdx = migrations.indexOf(trajectoryDeltaMigrations[0]!);

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(migrationHashes).toHaveLength(lockHashes.length);
    expect(migrationHashes.slice(startIdx, startIdx + deltaHashes.length)).toEqual(deltaHashes);
    expect(lockHashes.slice(startIdx, startIdx + deltaHashes.length)).toEqual(deltaHashes);
  });
});

const waitFor = async (read: () => unknown) => {
  for (let tries = 0; tries < 400 && !read(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const humanQuestionWorkflow = (): Workflow => parseWorkflow({
  schemaVersion: 1,
  id: "human-delta-test",
  name: "Human delta test",
  description: { en: "Test human answer delta", ru: "Тест записи ответа владельца" },
  inputs: [],
  outputs: [{ name: "kind", type: "string", required: false }],
  nodes: [
    {
      id: "review_gate",
      type: "human",
      role: "owner",
      question: "Ship it?",
      output: [
        { name: "answer", type: "string" },
        { name: "answer_kind", type: "enum", values: ["go", "fix", "abort", "timeout"] },
      ],
      timeoutSec: 600,
    },
    { id: "done", type: "action", action: "emit", map: { kind: "review_gate.answer_kind" } },
  ],
  edges: [{ from: "start", to: "review_gate" }, { from: "review_gate", to: "done" }],
});

describe("live owner intervention writers", () => {
  it("writes variant_selected from both the form path and workflow_answer", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const debugLogs: string[] = [];
    const warns: string[] = [];
    const origDebug = bb.log.debug.bind(bb.log);
    bb.log.debug = (message: string) => { debugLogs.push(message); origDebug(message); };
    bb.log.warn = (message: string) => { warns.push(message); };

    try {
      const settles: Array<(answer: OwnerAnswer) => void | Promise<void>> = [];
      const ownerAsk = {
        askInBackground: (_threadId: string, _request: unknown, onSettled: (answer: OwnerAnswer) => void | Promise<void>) => {
          settles.push(onSettled);
          return Promise.resolve(true);
        },
      };
      const ctx = { bb, db, log: () => undefined, ownerAsk } as unknown as ServerCore;
      const agents = {
        run: async () => ({ threadId: "helper-q", output: { question: "Ship it?" }, text: "" }),
      } as unknown as WorkflowAgents;
      const engine = new WorkflowEngine({ db, harnessVersion: "test" });
      registerPureActions(engine);
      const rt: ChainRuntime = { ctx, services: {}, pmThreadId: "thr_pm", projectId: "proj-human", runId: null };
      registerHumanForm(engine, ctx, agents, { runtimeOf: () => rt });

      const formRun = engine.start({ workflow: humanQuestionWorkflow(), runtime: rt, link: { projectId: "proj-human" } });
      await waitFor(() => settles.length === 1);
      await settles[0]!({ outcome: "answered", choice: { id: "2", label: "fix" }, text: "tests first", line: "fix — tests first" });
      await waitFor(() => engine.get(formRun.runId)?.status === "succeeded");

      const noPmRt: ChainRuntime = { ctx, services: {}, pmThreadId: null, projectId: "proj-human", runId: null };
      const answerRun = engine.start({ workflow: humanQuestionWorkflow(), runtime: noPmRt, link: { projectId: "proj-human" } });
      await waitFor(() => engine.get(answerRun.runId)?.status === "waiting");
      const answerRes = await answerWorkflowQuestion(ctx, { workflowEngine: engine }, { runId: answerRun.runId, choice: "go" });
      expect(answerRes).toMatchObject({ ok: true });

      const rows = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-human" });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.interventionKind === "variant_selected")).toBe(true);
      expect(rows[0]).toMatchObject({ workflowId: "human-delta-test", stageArchetype: "review-gate", maskedSummary: "fix: tests first" });
      expect(rows[1]).toMatchObject({ workflowId: "human-delta-test", stageArchetype: "review-gate", maskedSummary: "go" });
      expect(debugLogs.filter((l) => l.startsWith("trajectory delta kind=variant_selected"))).toHaveLength(2);
      expect(warns).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("writes rule_added and step_inserted from amendGoalsTool", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const debugLogs: string[] = [];
    const warns: string[] = [];

    try {
      const workflow = parseWorkflow({
        schemaVersion: 1,
        id: "amend-delta-test",
        name: "Amend delta test",
        description: { en: "Test amend delta", ru: "Тест правок целей" },
        inputs: [{ name: "query", type: "string", required: true }],
        outputs: [{ name: "text", type: "string", required: false }],
        nodes: [
          { id: "write_step", type: "action", action: "emit", map: { text: "$inputs.query" } },
        ],
        edges: [{ from: "start", to: "write_step" }],
      });
      const goals: RunGoal[] = [
        { id: "g1", done_when: "the summary is written", evidence: "text output" },
        { id: "g2", done_when: "it has three sources", evidence: "three urls" },
      ];
      let round = 0;
      const engine = new WorkflowEngine({
        db,
        harnessVersion: "test",
        auditGoals: async ({ goals: g }): Promise<GoalAudit> => {
          round += 1;
          return g.length === 2 && round === 1
            ? { met: ["g1"], unmet: [{ id: "g2", why: "missing sources" }] }
            : { met: g.map((x) => x.id), unmet: [] };
        },
      });
      registerPureActions(engine);
      const started = engine.start({
        workflow,
        inputs: { query: "hello" },
        goals,
        link: { projectId: "proj-amend" },
      });
      await engine.idle();
      expect(engine.get(started.runId)?.status).toBe("blocked");

      const deps: WorkflowToolDeps = {
        db,
        store: async () => ({ get: (id: string) => (id === workflow.id ? { workflow } : null), list: () => [{ workflow }] }) as never,
        engine: () => engine,
        runtime: (input) => ({ ctx: {} as never, services: {} as never, ...input }),
        debug: (m) => debugLogs.push(m),
        warn: (m) => warns.push(m),
      };
      const toolCtx = { threadId: "thr_pm", projectId: "proj-amend" };

      await amendGoalsTool(deps, { runId: started.runId, goals: [goals[0]!], reason: "Owner dropped the three-sources requirement" }, toolCtx);
      await engine.idle();
      await amendGoalsTool(deps, { runId: started.runId, reason: "Retry write step with updated query", rerun: { nodeId: "write_step", with: { query: "updated" } } }, toolCtx);
      await engine.idle();

      const rows = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-amend" });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        workflowId: "amend-delta-test",
        interventionKind: "rule_added",
        maskedSummary: "Owner dropped the three-sources requirement",
      });
      expect(rows[1]).toMatchObject({
        workflowId: "amend-delta-test",
        interventionKind: "step_inserted",
      });
      expect(rows[1]!.maskedSummary).toContain("write_step");
      expect(debugLogs.some((l) => l.includes(`kind=rule_added run=${started.runId} graph=amend-delta-test`))).toBe(true);
      expect(debugLogs.some((l) => l.includes(`kind=step_inserted run=${started.runId} graph=amend-delta-test`))).toBe(true);
      expect(warns).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("writes over_constraint for a no word and rule_added for a yes word with text", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run_word_1" }));
    const db = openDatabase(bb);
    const debugLogs: string[] = [];
    bb.log.debug = (message: string) => { debugLogs.push(message); };

    try {
      createRun(db, "run_word_1", "proj-word", "bb", "/repo");
      setRunThread(db, "run_word_1", "pm-word");
      createTask(db, { id: "t_no", runId: "run_word_1", kind: "bb", contract: {} as never });
      createTask(db, { id: "t_yes", runId: "run_word_1", kind: "bb", contract: {} as never });
      createAttempt(db, { id: "t_no-a1", runId: "run_word_1", taskId: "t_no" });
      transitionAttempt(db, "t_no-a1", "spawn_requested");
      transitionAttempt(db, "t_no-a1", "running", { threadId: "thr_w1" });

      registerQueueTool(
        { db, bb, log: () => undefined, isDisposed: () => false } as never,
        { ask: async () => undefined, answer: () => undefined, decide: () => ({ ok: true as const }) },
      );

      await harness.behavior.callAgentTool(
        "lane_pilot_queue",
        { action: "word", taskId: "t_no", decision: "no", text: "Do not modify production billing schema" },
        { threadId: "pm-word", projectId: "proj-word" },
      );
      await harness.behavior.callAgentTool(
        "lane_pilot_queue",
        { action: "word", taskId: "t_yes", decision: "yes", text: "Always keep backward-compatible SQLite columns" },
        { threadId: "pm-word", projectId: "proj-word" },
      );

      const rows = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-word" });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ interventionKind: "over_constraint" });
      expect(rows[0]!.maskedSummary).toContain("Do not modify production billing schema");
      expect(rows[1]).toMatchObject({ interventionKind: "rule_added", maskedSummary: "Always keep backward-compatible SQLite columns" });
      expect(debugLogs.some((l) => l.includes("kind=over_constraint run=run_word_1"))).toBe(true);
      expect(debugLogs.some((l) => l.includes("kind=rule_added run=run_word_1"))).toBe(true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("writes skill_request when lane_pilot_errand has skills or explicit skill intent", async () => {
    const sdk = {
      providers: { list: async () => [] },
      projects: { get: async () => ({ sources: [{ hostId: "host-1", path: "/proj" }] }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: "proj-errand", environmentId: "env-1" }),
        getPluginMetadata: async () => ({}),
        spawn: async () => ({ id: "errand-thr-1" }),
        stop: async () => undefined,
        output: async () => ({ output: "ERRAND: done" }),
        events: { list: async () => [{ type: "turn/started", seq: 1 }] },
      },
      environments: { get: async () => ({ id: "env-1", path: "/checkout", hostId: "host-1" }) },
    } as never;
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk });
    const db = openDatabase(bb);
    const debugLogs: string[] = [];
    bb.log.debug = (message: string) => { debugLogs.push(message); };

    try {
      createRun(db, "lprun-errand-1", "proj-errand", "cli", "/checkout");
      setRunThread(db, "lprun-errand-1", "pm-errand");
      const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: (id) => builtinWorkflow(id) });
      registerPureActions(engine);
      engine.register("agent", { reentrant: true, run: () => new Promise(() => undefined) } as never);
      const host = { call: async () => ({ hostId: "host-1", exitCode: 0, stdout: "", stderr: "" }) };
      const secrets = { check: async () => ({ missing: [], denied: [], wrongKind: [], unavailable: false, catalog: [] }), record: async () => undefined };
      const ctx = { bb, db, host, secrets, isDisposed: () => false, log: () => undefined } as never;
      const services = {
        workflowEngine: engine,
        workflowLibrary: { loadStore: async () => ({ store: await loadWorkflowStore({ builtin: BUILTIN_SOURCES }) }) },
      } as never;
      mountErrands(ctx, services);

      await harness.behavior.callAgentTool(
        "lane_pilot_errand",
        { task: "Check the CRM leads page and report counts.", skills: ["ru-text"] },
        { threadId: "pm-errand", projectId: "proj-errand" },
      );
      await harness.behavior.callAgentTool(
        "lane_pilot_errand",
        { task: "Задействуй скиллы копирайтинга для проверки заголовков лендинга." },
        { threadId: "pm-errand", projectId: "proj-errand" },
      );
      await harness.behavior.callAgentTool(
        "lane_pilot_errand",
        { task: "Open the status dashboard and read the uptime number." },
        { threadId: "pm-errand", projectId: "proj-errand" },
      );

      const rows = listUnprocessedTrajectoryDeltas(db, { projectId: "proj-errand" });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.interventionKind === "skill_request")).toBe(true);
      expect(rows[0]!.resolvedSkills).toEqual(["ru-text"]);
      expect(rows[1]!.maskedSummary).toContain("Задействуй скиллы копирайтинга");
      expect(debugLogs.some((l) => l.startsWith("trajectory delta kind=skill_request run="))).toBe(true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("warns and does not throw when trajectory delta write fails", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const warns: string[] = [];
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes(TRAJECTORY_DELTA_TABLE)) throw new Error("delta table locked");
      return origPrepare(sql);
    }) as typeof db.prepare;

    expect(() => {
      // Import via workflow/server index? noteHumanAnswer is exported from workflow/server.
      noteHumanAnswer(
        db,
        { runId: "wfrun_fail", workflowId: "wf_x", projectId: "proj-fail", nodeId: "ask", option: "go" },
        { warn: (m) => warns.push(m) },
      );
    }).not.toThrow();
    expect(warns).toEqual(["trajectory delta write failed: delta table locked"]);
    void harness.lifecycle.dispose();
  });
});
