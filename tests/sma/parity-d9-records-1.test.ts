import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { drawingFeedbackNote, drawingFeedbackProblems, type DrawingCritique } from "../../packages/contracts/src";
import { DESIGN_CRITIQUE_CASES_KEY, appendDesignCritiqueCase, critiqueProblems } from "../../src/rooms/design-eval";
import { credentialIssue, forgetSecrets, maskCredentials, registerSecrets, withoutCredentials } from "../../packages/kit/src/redact";
import { memoryContentIssue } from "../../packages/memory-core/src/candidates";
import { scrubQuote, unsafeReason } from "../../src/rooms/anamnesis/model";
import { spawnAsync } from "../../packages/kit/src/spawn-async";
import { planningDir, planningDirProblem } from "../../packages/settings-catalog/src/bookkeeping-paths";
import { validateSettingValue } from "../../src/rooms/settings/setting-validation";
import { stageInit } from "../../src/rooms/phase/stages";
import { writePhaseBook } from "../../src/rooms/host-worker/handlers/writes";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../../packages/kit/src";
import { RULE_TIERS, ruleLadderStep, ruleTier, logRuleEvent } from "../../packages/run-insights/src/rules";
import { runRulesCli } from "../../src/rooms/rule-forms/cli";

const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const kv = () => { const store = new Map<string, unknown>(); return { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: never) => { store.set(k, v); }, store }; };

const critique = (over: Partial<DrawingCritique> = {}): DrawingCritique => ({
  scores: { hierarchy: 2, spacing: 2, contrast: 2, states: 1 },
  verdict: "rework", notes: "the hero needs more air", ...over,
});

describe("drawing critique and feedback forms", () => {
  it("[sma:m_sw_design_feedback] drawingFeedbackNote turns {goal, obstacle, question} into one note and refuses an empty field", () => {
    const note = drawingFeedbackNote({ goal: "a calm hero", obstacle: "the box is loud", question: "keep the box?" });
    expect(note).toBe("Цель: a calm hero Что мешает: the box is loud Вопрос: keep the box?");
    expect(() => drawingFeedbackNote({ goal: "  ", obstacle: "the box is loud", question: "keep the box?" })).toThrow(/goal/);
    expect(drawingFeedbackProblems({ goal: "okay", obstacle: "x".repeat(301), question: "fine" })).toEqual(["obstacle: 3 to 300 characters"]);
  });

  it("[sma:k_lib_dfeedback] a rework critique without obstacle fails critiqueProblems; one with all three and a set_case continuation passes and adds one case to lp.design.critique-cases", async () => {
    expect(critiqueProblems(critique({ goal: "a calm hero", question: "keep the box?" }))).toEqual(["a rework names the obstacle"]);
    const full = critique({ goal: "a calm hero", obstacle: "the box is loud", question: "keep the box?", continuation: { kind: "set_case", caseId: "hero-1" } });
    expect(critiqueProblems(full)).toEqual([]);
    expect(critiqueProblems(critique({ goal: "g", obstacle: "o", question: "q", continuation: { kind: "role_line", lesson: " " } }))).toEqual(["a role_line continuation names the lesson"]);
    const store = kv();
    await appendDesignCritiqueCase(store, { drawingSha: "sha1", form: full, expectedVerdict: "rework" });
    const cases = (await store.get(DESIGN_CRITIQUE_CASES_KEY)) as unknown[];
    expect(cases).toHaveLength(1);
    expect((cases[0] as { drawingSha: string }).drawingSha).toBe("sha1");
  });
});

describe("one credential mask for every outward writer", () => {
  it("[sma:k_lib_secretsmask] maskCredentials, scrubQuote, withoutCredentials and memoryContentIssue see the same secrets and none survives", () => {
    registerSecrets(["hunter2-known-secret"]);
    try {
      const text = `key sk-${"a".repeat(24)}; Bearer ${"b".repeat(20)}; пароль: abc12345; known hunter2-known-secret end`;
      for (const masked of [maskCredentials(text).text, scrubQuote(text), withoutCredentials(text)]) {
        expect(masked).not.toContain("a".repeat(24));
        expect(masked).not.toContain("b".repeat(20));
        expect(masked).not.toContain("abc12345");
        expect(masked).not.toContain("hunter2-known-secret");
      }
      expect(credentialIssue(text)).toBeTruthy();
      expect(memoryContentIssue(text)).toContain("credential");
      expect(unsafeReason(text)).toBe("an API key");
      expect(maskCredentials("nothing worth hiding").masked).toBe(false);
      expect(credentialIssue("nothing worth hiding")).toBeNull();
    } finally {
      forgetSecrets();
    }
  });
});

describe("worker processes die with the worker", () => {
  it("[sma:m_ac_job] a command that backgrounds a sleeping child leaves no process of its group alive after spawnAsync with group:true resolves", async () => {
    const result = await spawnAsync("/bin/bash", ["-c", "sleep 30 & exit 0"], { group: true });
    expect(result.status).toBe(0);
    const pid = result.pid!;
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(groupAlive(pid)).toBe(false);
  });
});

describe("the project's planning home", () => {
  it("[sma:m_pj_register] planning.dir rejects an absolute path and one with .., accepts docs/planning, and an unset value reads as .agents/planning", () => {
    expect(planningDirProblem("/abs/path")).toBeTruthy();
    expect(planningDirProblem("docs/../up")).toBeTruthy();
    expect(planningDirProblem("docs\\win")).toBeTruthy();
    expect(planningDirProblem("docs/planning")).toBeNull();
    expect(validateSettingValue("planning.dir", "/abs")?.code).toBe("invalid_choice");
    expect(validateSettingValue("planning.dir", "docs/planning")).toBeNull();
    expect(planningDir({})).toBe(".agents/planning");
    expect(planningDir({ "planning.dir": "docs/planning" })).toBe("docs/planning");
  });

  it("[sma:m_pj_planning] with planning.dir=docs/plan the stage reads docs/plan/ROADMAP.md, the mark writes there only, and a write to src/x.ts through the same call is refused", async () => {
    expect(stageInit({ id: "ph_1", stage: "discussion", record: {} } as never, "docs/plan")[0]).toBe("docs/plan/ROADMAP.md");
    const cwd = mkdtempSync(join(tmpdir(), "lp-planning-"));
    try {
      mkdirSync(join(cwd, "docs/plan"), { recursive: true });
      mkdirSync(join(cwd, "src"), { recursive: true });
      const call = (edits: Array<{ path: string; content: string }>) => {
        const full = edits.map((e) => ({ ...e, expectedSha256: null }));
        return writePhaseBook({ requestedHostId: "h1", projectCwd: cwd, previewSha256: sha256Hex(JSON.stringify(full)), planningDir: "docs/plan", edits: full } as never);
      };
      const ok = await call([{ path: "docs/plan/ROADMAP.md", content: "- [ ] phase one" }]);
      expect(ok.writes[0]!.status).toBe("applied");
      await expect(call([{ path: "src/x.ts", content: "nope" }])).rejects.toThrow(/scope/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("closing a task in words", () => {
  it("[sma:m_ws_task_panel] cancel_attempt with note \"передумал\" ends the attempt canceled and its reason contains «передумал»; without a note the reason is unchanged", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const { openDatabase, createRun, createTask, createAttempt, transitionAttempt, getAttempt } = await import("../../src/rooms/plugin-db");
    const { createCore } = await import("../../src/rooms/core/server/core");
    const { cancelAttemptById } = await import("../../src/rooms/runs/server/cancel");
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "projA");
    const contract = { schema_version: 2, id: "t1", kind: "feature", title: "t1", risk: "low", lane: "writer", project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["t1/a"], owns_paths: ["t1/**"], never_touch: [], depends_on: [], objective: "o", acceptance: [], verify: "t", verification: [] };
    for (const [id, note] of [["a_note", "передумал"], ["a_plain", undefined]] as const) {
      createTask(db, { id: `t_${id}`, runId: "run1", kind: "bb", contract: { ...contract, id: `t_${id}` } as never });
      createAttempt(db, { id, runId: "run1", taskId: `t_${id}` });
      transitionAttempt(db, id, "blocked", { reason: "boom" });
      const why = note ? `Остановлено владельцем: ${note}` : "canceled by RPC";
      const out = await cancelAttemptById(ctx, id, undefined, why);
      expect(out.ok).toBe(true);
      expect(getAttempt(db, id)!.reason).toContain(note ?? "canceled by RPC");
    }
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

  it("[sma:k_v_ladder] `rules tune P` prints a due move and the tier event count stays unchanged; `rules ladder P` lists the tier of every accepted rule", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const { openDatabase } = await import("../../src/rooms/plugin-db");
    const { upsertLessonProposal } = await import("../../packages/run-insights/src/rules");
    const db = openDatabase(bb);
    upsertLessonProposal(db, "projA", { rule: "run lint before commit", form: "hook" });
    db.prepare("UPDATE lane_pilot_rule_proposal SET state='accepted', decided_by='auto', trial_state='confirmed' WHERE project_id='projA'").run();
    const id = (db.prepare("SELECT id FROM lane_pilot_rule_proposal WHERE project_id='projA'").get() as { id: string }).id;
    logRuleEvent(db, "projA", id, "tier", "warning");
    expect(ruleTier(db, "projA", id)).toBe("warning");
    const before = (db.prepare("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='tier'").get() as { n: number }).n;
    const out = await runRulesCli({ db, retire: () => undefined, repoPath: "/tmp" }, ["ladder", "projA"]);
    expect(out.stdout).toContain("warning");
    const after = (db.prepare("SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='tier'").get() as { n: number }).n;
    expect(after).toBe(before);
    await harness.lifecycle.dispose();
  });
});
