import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { drawingFeedbackNote, drawingFeedbackProblems, type DrawingCritique } from "../../packages/contracts/src";
import { DESIGN_CRITIQUE_CASES_KEY, appendDesignCritiqueCase, critiqueProblems } from "../../src/rooms/design-eval";
import { CREDENTIAL_MASK, forgetSecrets, maskCredentials, redactKnown, registerSecrets, withoutCredentials } from "../../packages/kit/src/redact";
import { memoryContentIssue } from "../../packages/memory-core/src/candidates";
import { maskPii, scrubQuote } from "../../src/rooms/anamnesis";
import { unsafeReason } from "../../src/rooms/anamnesis/model";
import { spawnAsync } from "../../packages/kit/src/spawn-async";
import { RULE_TIERS, ruleLadderStep, ruleTier, ruleTierState, logRuleEvent, listRuleEvents } from "../../packages/run-insights/src/rules";
import { adoptRuleProposal } from "../../src/rooms/self-repair/server/insights";
import { openDatabase } from "../../src/rooms/plugin-db";
import { runRulesCli } from "../../src/rooms/rule-forms/cli";
import { runMemoryImport } from "../../src/rooms/memory/server/import";
import type { MemorySettings } from "../../packages/memory-core/src";
import { registeredTools } from "../../src/rooms/platform/server";
import { phaseToolParams } from "../../src/rooms/phase/server/tool";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { createPhaseDriver } from "../phase-driver";

const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const kv = () => { const store = new Map<string, unknown>(); return { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: never) => { store.set(k, v); }, store }; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const critique = (over: Partial<DrawingCritique> = {}): DrawingCritique => ({
  scores: { hierarchy: 2, spacing: 2, contrast: 2, states: 1 },
  verdict: "rework", notes: "the hero needs more air", ...over,
});

describe("drawing critique and feedback forms", () => {
  it("[sma:m_sw_design_feedback] the form {goal, obstacle, question} becomes one note, and the design «нет» note carries it; an empty field is refused", () => {
    const note = drawingFeedbackNote({ goal: "a calm hero", obstacle: "the box is loud", question: "keep the box?" });
    expect(note).toBe("Цель: a calm hero Что мешает: the box is loud Вопрос: keep the box?");
    expect(() => drawingFeedbackNote({ goal: "  ", obstacle: "the box is loud", question: "keep the box?" })).toThrow(/goal/);
    expect(drawingFeedbackProblems({ goal: "okay", obstacle: "x".repeat(301), question: "fine" })).toEqual(["obstacle: 3 to 300 characters"]);
  });

  /** A phase at design, the PM tool registered over the real phase driver, the tool called as the PM calls it. */
  async function designWorld() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    for (const name of ["threads.stop", "threads.send", "threads.get", "threads.list", "threads.listRunning"]) harness.sdk.stub(name as never, async () => (name === "threads.get" ? { status: "idle" } : name === "threads.list" || name === "threads.listRunning" ? [] : {}));
    const { openDatabase, createRun } = await import("../../src/rooms/plugin-db");
    const { createCore } = await import("../../src/rooms/core/server/core");
    const { registerPhaseTool } = await import("../../src/rooms/phase/server/tool");
    const { sha256Hex } = await import("../../packages/kit/src");
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
    const ctx = createCore(bb, db);
    const { phases } = createPhaseDriver(ctx, { runBudgets: { get: () => undefined }, readWriterWorkspaceFile: async () => ({ sha256: sha256Hex("drawing"), sizeBytes: 7, content: "screens" }) } as never);
    registerPhaseTool(ctx, { phases } as never);
    const tool = registeredTools(bb.agents).get("lane_pilot_phase")!;
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "hero", goal: "a calm hero" });
    const path = `.agents/phases/${phase.id}/design/UI-SPEC.md`;
    const draw = async (form: unknown, extra: Record<string, unknown> = {}) => {
      savePhase(db, phase.id, { stage: "design", record: { ...phase.record, train: false, design: { decision: "needed", why: "screens" } }, at: 2 });
      const input = phaseToolParams.parse({ action: "drawing", phaseId: phase.id, paths: [path], designer: "design-lead", feasible: true, reviewer: "ui-review", critique: form, ...extra });
      return tool.execute(input, { threadId: "thr_pm", projectId: "projA", signal: new AbortController().signal });
    };
    const bookLines = () => listParts(db, phase.id).map((part) => part.text);
    return { bb, draw, bookLines, phases, id: phase.id, harness };
  }

  it("[sma:k_lib_dfeedback] through the PM tool: a rework without the form is accepted and the book says the form was not filled; a partial form is refused; set_case is stored; role_line adds the designer's line", async () => {
    const w = await designWorld();
    // As on main: a rework with scores and notes only goes through (the phase moves on); the book gets one line.
    await w.draw({ scores: { hierarchy: 2, spacing: 2, contrast: 2, states: 1 }, verdict: "rework", notes: "the hero needs more air" });
    expect(w.phases.status(w.id).phase.stage).toBe("execution");
    expect(w.bookLines().filter((line) => line === "critique form not filled")).toHaveLength(1);
    // Part of the form: refused, with the missing fields named; nothing stored.
    await expect(w.draw({ scores: { hierarchy: 2, spacing: 2, contrast: 2, states: 1 }, verdict: "rework", notes: "the hero needs more air", goal: "a calm hero" })).rejects.toThrow(/critique form is not filled/);
    expect(await w.bb.storage.kv.get(DESIGN_CRITIQUE_CASES_KEY)).toBeFalsy();
    // The whole form with a set_case continuation: accepted, one case stored with the drawing's sha and the verdict.
    await w.draw({ scores: { hierarchy: 2, spacing: 2, contrast: 2, states: 1 }, verdict: "rework", notes: "the hero needs more air", goal: "a calm hero", obstacle: "the box is loud", question: "keep the box?", continuation: { kind: "set_case", caseId: "hero-1" } });
    const cases = (await w.bb.storage.kv.get(DESIGN_CRITIQUE_CASES_KEY)) as Array<{ drawingSha: string; expectedVerdict: string; form: { continuation: { caseId: string } } }>;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ expectedVerdict: "rework", form: { continuation: { caseId: "hero-1" } } });
    expect(cases[0]!.drawingSha).toMatch(/^[a-f0-9]{64}$/);
    // A role_line continuation reaches the designer's role lines.
    await w.draw({ scores: { hierarchy: 3, spacing: 3, contrast: 3, states: 3 }, verdict: "pass", notes: "", continuation: { kind: "role_line", lesson: "leave air around the hero" } });
    const lines = (await w.bb.storage.kv.get("lp.role.lines:projA:design-lead")) as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("leave air around the hero");
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_lib_dfeedback] critiqueProblems: no goal/obstacle/question needed; once one is given all three are checked; the continuation names its lesson or case", async () => {
    expect(critiqueProblems(critique())).toEqual([]);
    expect(critiqueProblems(critique({ goal: "a calm hero", question: "keep the box?" }))).toEqual(["the feedback form names the obstacle"]);
    expect(critiqueProblems(critique({ goal: "g", obstacle: "o", question: "q", continuation: { kind: "set_case", caseId: "hero-1" } }))).toEqual([]);
    expect(critiqueProblems(critique({ continuation: { kind: "role_line", lesson: " " } }))).toEqual(["a role_line continuation names the lesson"]);
    const store = kv();
    await appendDesignCritiqueCase(store, { drawingSha: "sha1", form: critique(), expectedVerdict: "rework" });
    expect(((await store.get(DESIGN_CRITIQUE_CASES_KEY)) as unknown[])).toHaveLength(1);
  });
});

/** Ordinary prose that holds a credential word; none of it is a credential. */
const PROSE = [
  "The password reset flow sends an email",
  "token refresh happens every hour",
  "use the token bucket algorithm",
  "We rotate the API key monthly",
  "GITHUB_TOKEN: needed for release",
  "Write to ann@example.com please",
];
const KEY = `sk-${"a".repeat(24)}`;

const openDb = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);

describe("one credential masker; every writer refuses exactly what it refused before", () => {
  // What each caller did on main, written out: the refusal of memory and anamnesis is their own pattern, not the shared masker's.
  it("[sma:k_lib_secretsmask] memory-core and anamnesis refuse ordinary prose never, and main's real credentials as before", () => {
    for (const text of PROSE) {
      expect(memoryContentIssue(text), text).toBeNull();
      expect(unsafeReason(text), text).toBeNull();
    }
    const positives: Array<[string, string | null, string | null]> = [
      // text, memory refusal (substring or null), anamnesis refusal (or null)
      [`key ${KEY}`, "credential", "an API key"],
      ["password: hunter22", "credential", null],
      ["API_KEY=abc12345", "credential", "a credential assignment"],
      [`Authorization: Bearer ${"b".repeat(24)}`, "credential", null],
      ["-----BEGIN RSA PRIVATE KEY-----", "credential", "a private key"],
      [`jwt eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`, "credential", null],
      ["secret correcthorse", null, null],
    ];
    for (const [text, memory, anamnesis] of positives) {
      const issue = memoryContentIssue(text);
      if (memory) expect(issue, text).toContain(memory); else expect(issue, text).toBeNull();
      expect(unsafeReason(text), text).toBe(anamnesis);
    }
  });

  it("[sma:k_lib_secretsmask] import masks and stores a line as before: prose kept, an assignment masked, a real key masked", () => {
    const settings: MemorySettings = { enabled: true, maintain: true, inject: true, audience: "subagent", personalBot: "", searchEngine: "auto", coreBudget: 999_999, noteBudget: 999_999, indexBudget: 9_999_999, contextBudget: 2500, maintainEvery: 3 };
    const expected: Array<[string, string]> = [
      ["The password reset flow sends an email", "The password reset flow sends an email"],
      ["token refresh happens every hour", "token refresh happens every hour"],
      ["use the token bucket algorithm", "use the token bucket algorithm"],
      ["We rotate the API key monthly", "We rotate the API key monthly"],
      ["Write to ann@example.com please", "Write to [email] please"],
      ["GITHUB_TOKEN: needed for release", "GITHUB_TOKEN: *** for release"],
      ["secret correcthorse", "secret correcthorse"],
    ];
    for (const [text, stored] of expected) {
      const database = openDb();
      const report = runMemoryImport({ db: database, projectId: "p", source: "bb-memory", jsonl: `${JSON.stringify({ source_id: "s1", content: `${text} for the billing service.`, kind: "project", concepts: ["docs"] })}\n`, settings });
      expect(report.outcomes[0]!.outcome, text).toBe("added");
      const row = database.prepare("SELECT content FROM lane_pilot_memory").get() as { content: string };
      expect(row.content, text).toContain(stored);
    }
    // A real key is masked and the line stored, as before (the store's own check sees the masked text).
    const masked = runMemoryImport({ db: openDb(), projectId: "p", source: "bb-memory", jsonl: `${JSON.stringify({ source_id: "s2", content: `The deploy key is ${KEY} for the billing service.`, kind: "project", concepts: ["docs"] })}\n`, settings });
    expect(masked.outcomes[0]!.outcome).toBe("added");
  });

  it("[sma:k_lib_secretsmask] the masks (phase intake, quotes, episode enrichment) hide at least what they hid before, and the shared masker leaves prose alone", () => {
    registerSecrets(["hunter2-known-secret"]);
    try {
      // Phase intake: main's loose form is kept, so «secret correcthorse» and «pass hunter» are masked as they were.
      expect(withoutCredentials("secret correcthorse")).toBe(`secret ${CREDENTIAL_MASK}`);
      expect(withoutCredentials("pass hunter")).toBe(`pass ${CREDENTIAL_MASK}`);
      expect(withoutCredentials("пароль: abc12345")).toBe(`пароль: ${CREDENTIAL_MASK}`);
      expect(withoutCredentials("login ann@example.com S3cr3t!x")).toBe(`login ann@example.com ${CREDENTIAL_MASK}`);
      expect(withoutCredentials("The password reset flow sends an email")).toBe(`The password ${CREDENTIAL_MASK} flow sends an email`);
      expect(withoutCredentials("Write to ann@example.com please")).toBe("Write to ann@example.com please");
      expect(withoutCredentials(withoutCredentials("token abcd1234"))).toBe(`token ${CREDENTIAL_MASK}`);
      expect(withoutCredentials(`key ${KEY}`)).not.toContain(KEY);
      // Quotes and episode enrichment (redactKnown → scrubQuote → maskPii) and the shared masker.
      const episode = (text: string) => maskPii(scrubQuote(redactKnown(text), 2000)).text;
      for (const text of PROSE.filter((line) => !line.startsWith("GITHUB_TOKEN"))) {
        expect(scrubQuote(text), text).toBe(text);
        expect(maskCredentials(text), text).toEqual({ text, masked: false });
      }
      expect(maskCredentials("secret correcthorse")).toEqual({ text: "secret correcthorse", masked: false });
      expect(episode("GITHUB_TOKEN: needed for release")).toBe("GITHUB_TOKEN: *** for release");
      const text = `key ${KEY}; Bearer ${"b".repeat(20)}; API_KEY=abc12345; known hunter2-known-secret end`;
      for (const masked of [maskCredentials(text).text, scrubQuote(text), episode(text), withoutCredentials(text)]) {
        expect(masked).not.toContain("a".repeat(24));
        expect(masked).not.toContain("b".repeat(20));
      }
      for (const masked of [maskCredentials(text).text, scrubQuote(text), episode(text)]) expect(masked).not.toContain("hunter2-known-secret");
      expect(maskCredentials("nothing worth hiding").masked).toBe(false);
    } finally {
      forgetSecrets();
    }
  });
});

describe("worker processes die with the worker", () => {
  it("[sma:m_ac_job] group:true kills the group on timeout and on output overflow, and signals nothing on a normal finish", async () => {
    const timedOut = await spawnAsync("/bin/bash", ["-c", "sleep 30 & sleep 30"], { group: true, timeout: 300 });
    expect(timedOut.error).toMatchObject({ code: "ETIMEDOUT" });
    await sleep(500);
    expect(groupAlive(timedOut.pid!)).toBe(false);

    const overflow = await spawnAsync("/bin/bash", ["-c", "sleep 30 & head -c 200000 /dev/zero"], { group: true, maxBuffer: 100 });
    expect(overflow.error).toMatchObject({ code: "ENOBUFS" });
    await sleep(500);
    expect(groupAlive(overflow.pid!)).toBe(false);

    // A command that leaves a background process on purpose keeps it, as before.
    const normal = await spawnAsync("/bin/bash", ["-c", "sleep 30 & exit 0"], { group: true });
    expect(normal.status).toBe(0);
    await sleep(2_600);
    try { expect(groupAlive(normal.pid!)).toBe(true); } finally { try { process.kill(-normal.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
});

describe("closing a task in words", () => {
  it("[sma:m_ws_task_panel] the cancel_attempt RPC with note \"передумал\" ends the attempt canceled with the note in its reason; without a note the reason is the old one", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.stop" as never, async () => ({}));
    harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
    harness.sdk.stub("threads.listRunning" as never, async () => []);
    const { openDatabase, createRun, createTask, createAttempt, getAttempt } = await import("../../src/rooms/plugin-db");
    const { createCore } = await import("../../src/rooms/core/server/core");
    const { runsRpc } = await import("../../src/rooms/runs/server/rpc/runs");
    const db = openDatabase(bb);
    const rpc = runsRpc(createCore(bb, db), {} as never) as unknown as { cancel_attempt: (input: { attemptId: string; note?: string; code?: string }, ctx?: unknown) => Promise<{ ok: boolean }> };
    createRun(db, "run1", "projA", "bb", "/repo");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "with_note", runId: "run1", taskId: "t1" });
    createAttempt(db, { id: "plain", runId: "run1", taskId: "t1" });
    expect((await rpc.cancel_attempt({ attemptId: "with_note", note: "передумал" })).ok).toBe(true);
    expect(getAttempt(db, "with_note")).toMatchObject({ state: "canceled" });
    expect(getAttempt(db, "with_note")!.reason).toContain("передумал");
    expect((await rpc.cancel_attempt({ attemptId: "plain" })).ok).toBe(true);
    expect(getAttempt(db, "plain")).toMatchObject({ state: "canceled", reason: "canceled by RPC" });
    await harness.lifecycle.dispose();
  });
});

describe("the rule maturation ladder", () => {
  it("[sma:k_lib_ladder] a confirmed hook rule with 10 applications and 0 recurrences at warning steps to soft-deny; with 2 recurrences it steps back to note; a text-only rule never passes warning", () => {
    const confirmed = { confirmed: true, applied: 10, recurrences: 0 };
    expect(ruleLadderStep("warning", confirmed, { hasMechanism: false, form: "hook" })).toBe("up");
    expect(ruleLadderStep("note", { confirmed: true, applied: 10, recurrences: 2 }, { hasMechanism: false, form: "hook" })).toBe("stay");
    expect(ruleLadderStep("warning", { confirmed: true, applied: 10, recurrences: 2 }, { hasMechanism: false, form: "hook" })).toBe("down");
    expect(ruleLadderStep("warning", confirmed, { hasMechanism: false, form: null })).toBe("stay");
    expect(ruleLadderStep("soft-deny", confirmed, { hasMechanism: true, form: "check" })).toBe("up");
    expect(ruleLadderStep("soft-deny", confirmed, { hasMechanism: false, form: "check" })).toBe("stay");
    expect(RULE_TIERS).toEqual(["note", "warning", "soft-deny", "auto-fix"]);
  });

  it("[sma:k_v_ladder] `rules tune` (with and without a project) prints the due move from the rule's own evidence, a move needs evidence newer than the last tier event, and tier events take no slot in the last-30 list", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const { openDatabase, createRun, createTask } = await import("../../src/rooms/plugin-db");
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const t0 = Date.now() - 600_000;
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at)
      VALUES ('r1','projA','r1','run lint before commit','model','proposed',3,3,'[]',1,1,1)`).run();
    adoptRuleProposal(db, "projA", "r1", t0);
    db.prepare("UPDATE lane_pilot_rule_proposal SET trial_state='confirmed', form='hook' WHERE id='r1'").run();
    for (let i = 0; i < 10; i++) {
      createTask(db, { id: `t${i}`, runId: "run1", kind: "bb", contract: {} });
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at,attempt_no,dirt_before_json) VALUES(?,?,?,?,?,?,?,?)").run(`a${i}`, "run1", `t${i}`, "accepted", t0 + 1_000 + i, t0 + 1_000 + i, 1, "[]");
      db.prepare("INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES(?,?)").run(`a${i}`, JSON.stringify({ dispatchContext: { rulesPicked: { total: 1, picked: ["r1"] } } }));
    }
    const deps = { db, retire: () => undefined, repoPath: "/tmp" };
    const tierEvents = () => (db.prepare("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='tier'").get() as { n: number }).n;

    // 10 applications since the rule was accepted: note -> warning is due; with a project and without one the same, and the count of applications is not 0.
    for (const args of [["tune", "projA"], ["tune"]]) expect((await runRulesCli(deps, args)).stdout).toContain("r1: note -> warning (10 applications, no recurrence)");
    expect((await runRulesCli(deps, ["ladder"])).stdout).toContain("applied 10");
    expect(tierEvents()).toBe(0); // tune only prints

    // The nightly job logged that move; with no evidence newer than it, the next move is not due.
    logRuleEvent(db, "projA", "r1", "tier", "warning", Date.now());
    expect(ruleTier(db, "projA", "r1")).toBe("warning");
    expect(ruleTierState(db, "projA", "r1").movedAt).not.toBeNull();
    expect((await runRulesCli(deps, ["tune", "projA"])).stdout).toBe("no moves");
    expect((await runRulesCli(deps, ["ladder", "projA"])).stdout).toContain("warning");

    // Tier events never push the rule history out of the last 30 rows.
    for (let i = 0; i < 40; i++) logRuleEvent(db, "projA", "r1", "tier", "warning", Date.now() + i);
    expect(listRuleEvents(db, "projA", 30).some((event) => event.action === "tier")).toBe(false);
    expect(listRuleEvents(db, "projA", 30).map((event) => event.action)).toContain("adopted");
    await harness.lifecycle.dispose();
  });
});
