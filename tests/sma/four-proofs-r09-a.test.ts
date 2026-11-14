// Region 9 · Person and window, batch a (n755 … n784): the server half of the window's doors. Each test calls the real handler with a known state and
// checks the whole answer or the whole call it makes (the conveyor's stored state, which phase function a stage action reaches, the task card's fields).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { readTaskCard } from "../../src/rooms/runs/server/task-board";
import { phaseRpc } from "../../src/rooms/phase/server/rpc";
import { ROLE_GROUPS } from "../../src/rooms/native-agent/ui/team-model";
import { UI_CATALOG } from "../../packages/settings-catalog/src/ui-catalog";
import { parseMemorySettings } from "../../packages/memory-core/src/settings";
import { switchOn } from "../../packages/models/src/setting-value";
import { parseProjectLifeSettings } from "../../src/rooms/project-life/project-life";
import plugin from "../../server";

describe("region 9 · the switch for the whole conveyor", () => {
  it("[sma:d_pipeline] the conveyor switch off stores when and why and says so on every read, a second off keeps the first time and reason, on clears it, and a read of a switch nobody touched says on", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const call = (params: Record<string, unknown>) => harness.behavior.callRpc("conveyor", params as never) as Promise<{ on: boolean; since: string | null; reason: string | null }>;
    expect(await call({})).toEqual({ on: true, since: null, reason: null });
    const off = await call({ set: "off", reason: "  deploy window  " });
    expect(off).toMatchObject({ on: false, reason: "deploy window" });
    expect(off.since).toMatch(/^\d{4}-\d\d-\d\dT/);
    // A read shows what was stored, the same on every read.
    expect(await call({})).toEqual(off);
    // Off again with another reason changes nothing: the first word stands.
    expect(await call({ set: "off", reason: "second thoughts" })).toEqual(off);
    expect(await call({ set: "on" })).toEqual({ on: true, since: null, reason: null });
    expect(await call({})).toEqual({ on: true, since: null, reason: null });
  });
});

describe("region 9 · starting a stage of a phase", () => {
  it("[sma:d_phase_stage] each stage action of the phase door reaches its own stage function with its own words and answers with the phase's status; an action on no phase is refused, and the owner's note reaches the writers as a correction by the owner", async () => {
    const seen: Array<[string, unknown]> = [];
    const log = (name: string, result: unknown = { id: "ph1" }) => (input: unknown) => { seen.push([name, input]); return result; };
    const api = {
      resolve: (_project: unknown, ref: string) => ({ id: ref }), status: (id: string) => ({ status: id }),
      open: log("open", { id: "ph_new" }), context: log("context"), plan: log("plan"), planCheck: log("planCheck"), drawing: log("drawing"), goalAudit: log("goalAudit"),
      correct: (input: unknown) => { seen.push(["correct", input]); return { phase: { id: "ph1" } }; }, answer: log("answer"), lessons: log("lessons"),
    } as never;
    const rpc = phaseRpc(api);
    const act = (action: string, payload: Record<string, unknown>, phaseId: string | null = "ph1") => rpc.phase_act({ action, projectId: "projA", pmThreadId: "pm1", phaseId, payload } as never);
    expect(await act("open", { title: "Footer", goal: "a footer", roadmapRow: "row-1" }, null)).toEqual({ status: "ph_new" });
    expect(await act("context", { docs: ["a.md"], appetite: "2 days", noGos: ["x"], requirements: "r", decisions: "d", risks: { value: "v" } })).toEqual({ status: "ph1" });
    expect(await act("plan", { items: [{ id: "a" }], design: true })).toEqual({ status: "ph1" });
    expect(await act("plan_check", { decision: "approved", by: "critic", summary: "ok", wfRunId: "wf1" })).toEqual({ status: "ph1" });
    expect(await act("drawing", { paths: ["d.png"], designer: "d1", feasible: true, reviewer: "r1", critique: "fine", lesson: "l" })).toEqual({ status: "ph1" });
    expect(await act("goal_audit", { state: "met", by: "auditor", summary: "s", points: [] })).toEqual({ status: "ph1" });
    expect(await act("correct", { note: "use the token", pieces: ["a"] })).toEqual({ status: "ph1" });
    expect(await act("answer", { questionId: "q1", answer: "grey" })).toEqual({ status: "ph1" });
    expect(await act("lessons", { analysis: "a", reviewRun: "rr", reviewerNode: "n" })).toEqual({ status: "ph1" });
    expect(seen).toEqual([
      ["open", { projectId: "projA", pmThreadId: "pm1", title: "Footer", goal: "a footer", roadmapRow: "row-1" }],
      ["context", { phaseId: "ph1", docs: ["a.md"], risks: { value: "v" }, appetite: "2 days", noGos: ["x"], requirements: "r", decisions: "d", by: "screen" }],
      ["plan", { phaseId: "ph1", items: [{ id: "a" }], design: true }],
      ["planCheck", { phaseId: "ph1", decision: "approved", by: "critic", summary: "ok", wfRunId: "wf1" }],
      ["drawing", { phaseId: "ph1", paths: ["d.png"], designer: "d1", feasible: true, contradiction: undefined, reviewer: "r1", critique: "fine", lesson: "l" }],
      ["goalAudit", { phaseId: "ph1", state: "met", by: "auditor", summary: "s", points: [] }],
      ["correct", { phaseId: "ph1", note: "use the token", pieces: ["a"], by: "owner" }],
      ["answer", { phaseId: "ph1", questionId: "q1", answer: "grey", by: "owner via screen" }],
      ["lessons", { phaseId: "ph1", analysis: "a", reviewRun: "rr", reviewerNode: "n" }],
    ]);
    await expect(act("plan", { items: [] }, null)).rejects.toThrow("plan names the phase");
  });
});

describe("region 9 · the task card", () => {
  const world = () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "bb"); setRunThread(db, "run", "thr_pm");
    return db;
  };
  it("[sma:d_task] the card of a task carries its contract (objective, acceptance, owned paths, outputs, dependencies, checks), the receipts of its stages in the pipeline's order, its attempts with their reasons, the state and reason of the latest attempt, the PM chat and the threads that worked on it; a task that does not exist has no card; a chain has a card of its own steps", () => {
    const db = world();
    createTask(db, { id: "t", runId: "run", kind: "bb", contract: { id: "t", title: "Fix the form", display_title: "The form saves", kind: "fix", area: "page:form", objective: "Make the form save", acceptance: ["form saves", "errors shown"],
      owns_paths: ["src/form/**"], expected_outputs: ["src/form/save.ts"], depends_on: ["u"], verification: [{ command: "npm test" }, { command: "npm run lint" }] } });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t" });
    for (const state of ["spawn_requested", "running", "blocked"]) transitionAttempt(db, "a1", state, state === "blocked" ? { reason: "tests red" } : {});
    createAttempt(db, { id: "a2", runId: "run", taskId: "t" });
    for (const state of ["spawn_requested", "running", "blocked"]) transitionAttempt(db, "a2", state, state === "blocked" ? { reason: "needs_human: may I?" } : {});
    // Recorded out of the pipeline's order on purpose.
    recordStage(db, { runId: "run", taskId: "t", stageId: "code-critique" as never, state: "failed" as never, input: "diff", reason: "dead code", threadId: "thr_c" });
    recordStage(db, { runId: "run", taskId: "t", stageId: "plan-critique" as never, state: "passed" as never, input: "plan", threadId: "thr_p" });
    const card = readTaskCard(db, { runId: "run", taskId: "t" })!;
    expect(card).toMatchObject({ kind: "task", title: "The form saves", techTitle: "Fix the form", taskKind: "fix", area: "page:form", id: "t", projectId: "P", state: "blocked", reason: "needs_human: may I?", pmThreadId: "thr_pm" });
    expect(card.contract).toEqual({ objective: "Make the form save", acceptance: ["form saves", "errors shown"], ownsPaths: ["src/form/**"], expectedOutputs: ["src/form/save.ts"], dependsOn: ["u"], checks: ["npm test", "npm run lint"] });
    expect(card.attempts.map((attempt) => [attempt.id, attempt.no, attempt.state, attempt.reason])).toEqual([["a1", 1, "blocked", "tests red"], ["a2", 2, "blocked", "needs_human: may I?"]]);
    expect(card.stages.map((stage) => [stage.id, stage.state, stage.threadId])).toEqual([["plan-critique", "passed", "thr_p"], ["code-critique", "failed", "thr_c"]]);
    expect(card.roots).toEqual([{ id: "thr_p", role: "plan-critique" }, { id: "thr_c", role: "code-critique" }]);
    expect(readTaskCard(db, { runId: "run", taskId: "no-such-task" })).toBeNull();
    expect(readTaskCard(db, { runId: "no-such-run", taskId: "t" })).toBeNull();
  });
});

describe("region 9 · switching a worker", () => {
  it("[sma:d_agent_toggle] every worker the team table lets the owner switch shows the state the launch reads when nothing was saved: the switch's fallback is the setting's default in the catalog, and no setting is switched from two rows", () => {
    const rows = ROLE_GROUPS.flatMap((group) => group.roles).flatMap((role) => (role.enabled && "fallback" in role.enabled ? [{ role: role.id, key: role.enabled.key, fallback: role.enabled.fallback }] : []));
    expect(rows.map((row) => row.key).sort()).toEqual(["browser_qa.enabled", "code_critique.enabled", "memory.enabled", "plan_critique.enabled", "pm_read.enabled", "project_life.enabled", "specialist.enabled"]);
    // What the code reads when nothing was saved: the memory and project-life parsers, the browser-check switch (on unless switched off, the owner's word of
    // 2026-11-11) and, for the stages whose default lives only in the catalog, that row.
    const catalog = (key: string) => !["false", "off", "no", "0"].includes(String(UI_CATALOG.find((entry) => entry.setting === key && entry.scope === "project")!.defaultValue).toLowerCase());
    const launch: Record<string, boolean> = {
      "memory.enabled": parseMemorySettings({}).enabled, "project_life.enabled": parseProjectLifeSettings({}).enabled, "browser_qa.enabled": switchOn({}, "browser_qa.enabled"),
      "plan_critique.enabled": catalog("plan_critique.enabled"), "code_critique.enabled": catalog("code_critique.enabled"), "specialist.enabled": catalog("specialist.enabled"), "pm_read.enabled": catalog("pm_read.enabled"),
    };
    expect(launch["memory.enabled"]).toBe(true);
    expect(launch["browser_qa.enabled"]).toBe(true);
    expect(Object.fromEntries(rows.map((row) => [row.key, row.fallback]))).toEqual(launch);
  });
});
