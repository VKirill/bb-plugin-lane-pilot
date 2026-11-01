import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setJevForTests } from "@lane-pilot/jev";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server";
import { answerDecision, getDecision, labelDecision, openDecision } from "../../src/rooms/lead/server/journal";
import { addRoad, getRoad, proposeRoad } from "../../src/rooms/lead/server/road";
import { createLeadService } from "../../src/rooms/lead/server/service";
import { runLeadCli } from "../../src/rooms/lead/cli";
import { MEMORY_EXAM_KEY } from "../../src/rooms/lead/server/memory-exam";
import { getTick, openTick, patchTick } from "../../src/rooms/lead/server/tick-store";
import { proposalDecisionId, proposalItemKey } from "../../src/rooms/lead/server/tick";
import { postOwnerItem } from "../../src/rooms/owner-waiting";
import { loadProjectSettings, openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lead-svc-")); process.env.LANE_PILOT_LEAD_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.LANE_PILOT_LEAD_DIR; });

function world(start: () => Promise<unknown> = async () => ({ ok: true, runId: "wf_1" }), runs: Record<string, { status: string; error?: string | null; failedNode?: string | null; reason?: string | null }> = {}) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const starts: unknown[] = [];
  const services = {
    workflowTriggers: { start: vi.fn(async (input: unknown) => { starts.push(input); return start(); }), pmOf: async () => null },
    docsPlaces: async () => [],
    workflowEngine: { register: () => undefined, get: (runId: string) => runs[runId] ? { runId, output: null, reason: null, error: null, failedNode: null, waiting: [], stopped: false, ...runs[runId] } : null },
  } as unknown as Services;
  const lead = createLeadService(createCore(bb, db), services);
  return { bb, db, lead, starts, services };
}
const ownerItem = (db: ReturnType<typeof openDatabase>, key: string) => db.prepare("SELECT key, kind, state FROM lane_pilot_owner_item WHERE key=?").get(key) as { key: string; kind: string; state: string } | undefined;

describe("a tick of the lead", () => {
  it("opens a receipt row, starts the graph with the tick id and refuses a second tick while one runs", async () => {
    const { db, lead, starts } = world();
    const result = await lead.runTick("manual", 1_000);
    expect(result).toMatchObject({ ok: true, runId: "wf_1" });
    const tick = getTick(db, (result as { tickId: string }).tickId)!;
    expect(tick).toMatchObject({ status: "running", trigger: "manual", wf_run_id: "wf_1", started_at: 1_000 });
    expect(starts[0]).toMatchObject({ workflowId: "lead-tick", source: "manual", key: `lead-tick:${tick.id}`, inputs: { tickId: tick.id, trigger: "manual" }, detached: true });
    const again = await lead.runTick("cron", 2_000);
    expect(again.ok).toBe(false);
    expect((again as { reason: string }).reason).toMatch(/still running/);
  });

  it("closes the receipt as error when the graph refuses to start", async () => {
    const { db, lead } = world(async () => ({ ok: false, reason: "not_runnable", message: "no such graph" }));
    const result = await lead.runTick("manual", 1_000);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("no such graph");
    expect(getTick(db, (result as { tickId: string }).tickId)).toMatchObject({ status: "error", ended_at: 1_000 });
  });
});

describe("the sweep every 15 minutes", () => {
  it("closes a tick without a receipt after 90 minutes and tells the owner once; exports ROAD.md once a day; starts nothing while off", async () => {
    const { db, lead, starts } = world();
    openTick(db, "cron", 0, "tick_old");
    const first = await lead.sweep(100 * 60_000);
    expect(first).toEqual({ stale: ["tick_old"], started: null, exported: true });
    expect(getTick(db, "tick_old")).toMatchObject({ status: "no_receipt" });
    expect(ownerItem(db, "lead-tick:tick_old")).toMatchObject({ kind: "tick_no_receipt", state: "open" });
    expect(existsSync(join(dir, "ROAD.md"))).toBe(true);
    const second = await lead.sweep(101 * 60_000);
    expect(second).toEqual({ stale: [], started: null, exported: false });
    expect(starts).toHaveLength(0);
  });

  it("closes a tick whose graph failed before the receipt at once, with the step's error for the owner (live 0.1.447: the agent step could not start)", async () => {
    const { db, lead } = world(undefined, { wf_dead: { status: "failed", error: "thread_failed: Command thread.start failed", failedNode: "think" } });
    openTick(db, "manual", 10 * 60_000, "tick_dead");
    patchTick(db, "tick_dead", { wf_run_id: "wf_dead" });
    openTick(db, "manual", 11 * 60_000, "tick_alive");
    patchTick(db, "tick_alive", { wf_run_id: "wf_alive" });
    const result = await lead.sweep(12 * 60_000);
    expect(result.stale).toEqual(["tick_dead"]);
    expect(getTick(db, "tick_dead")).toMatchObject({ status: "error" });
    expect(getTick(db, "tick_alive")).toMatchObject({ status: "running" });
    const item = db.prepare("SELECT key, kind, state, why FROM lane_pilot_owner_item WHERE key=?").get("lead-tick:tick_dead") as { kind: string; why: string };
    expect(item).toMatchObject({ kind: "tick_error" });
    expect(item.why).toContain("failed на шаге think");
    expect(item.why).toContain("thread.start failed");
  });

  it("starts a due tick when the lead is on", async () => {
    const { db, lead, starts } = world();
    saveProjectSetting(db, "*", "lead.enabled", "on");
    saveProjectSetting(db, "*", "lead.tick_cron", "* * * * *");
    const now = Date.UTC(2026, 10, 2, 12, 0, 30);
    const result = await lead.sweep(now);
    expect(result.started).toMatch(/^tick_/);
    expect(starts).toHaveLength(1);
    expect(getTick(db, result.started!)).toMatchObject({ status: "running", trigger: "cron" });
    expect(lead.nextTickAt(now)).toBeGreaterThan(now);
  });
});

describe("the nightly exam of the rights", () => {
  it("opens a class on the journal's numbers, writes one quiet line for the owner and remembers the change", async () => {
    const { db, lead } = world();
    for (let i = 0; i < 25; i += 1) {
      const id = `lead:road_${i}`;
      openDecision(db, { id, surface: "lead", class: "next_step", risk: "low", situation: { q: i }, options: ["yes", "later", "no"] }, 1_000 + i);
      db.prepare("UPDATE lane_pilot_decision SET prediction_json=?, predicted_at=?, predictor='test' WHERE id=?").run(JSON.stringify({ option: "yes", p: 0.9 }), 1_100 + i, id);
      answerDecision(db, id, { option: "yes" }, "owner", 2_000 + i);
      labelDecision(db, id, "exact", 3_000 + i);
    }
    const { exams, changes } = await lead.exam(5_000);
    expect(exams.find((exam) => exam.class === "next_step")).toMatchObject({ n: 25, k: 25, tier: "decides" });
    expect(changes).toEqual([{ class: "next_step", from: "proposes", to: "decides", reasons: [] }]);
    expect(ownerItem(db, "lead-right:next_step:5000")).toMatchObject({ kind: "right_changed", state: "open" });
    const state = await lead.state(6_000);
    expect(state.rights.find((row) => row.class === "next_step")!.tier).toBe("decides");
    expect(state.lastExam).toMatchObject({ at: 5_000, changes: [{ class: "next_step", to: "decides" }] });
  });
});

describe("the state for the panel and the CLI", () => {
  it("is a JSON value before the first exam too: the hub kv answers undefined for a key never written (lead_shadow drill, 0.1.448: HTTP 500)", async () => {
    const { bb, lead } = world();
    vi.spyOn(bb.storage.kv, "get").mockImplementation(async () => undefined as never);
    const state = await lead.state(1_000);
    expect(state.lastExam).toBeNull();
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
  });
});

describe("the owner's answer to a proposal", () => {
  it("moves the branch, the journal row and the list line together, once", async () => {
    const { db, lead } = world();
    addRoad(db, { id: "d1", title: "Grow", kind: "direction", source: "lead", why: "the owner wants growth" }, 1);
    addRoad(db, { id: "o1", parentId: "d1", title: "Paid plans", kind: "option", source: "lead", why: "users asked twice", class: "next_step" }, 2);
    const decisionId = proposalDecisionId("o1");
    openDecision(db, { id: decisionId, surface: "lead", class: "next_step", situation: { title: "Paid plans" }, options: ["yes", "later", "no"] }, 3);
    db.prepare("UPDATE lane_pilot_decision SET prediction_json=?, predicted_at=?, predictor='test' WHERE id=?").run(JSON.stringify({ option: "later", p: 0.7 }), 4, decisionId);
    proposeRoad(db, "o1", decisionId, 5);
    postOwnerItem(db, { key: proposalItemKey("o1"), source: "lead", kind: "proposal", what: "Paid plans", why: "users asked twice" }, 5);
    const result = await lead.decide("o1", "yes", "да, делаем", "owner", 10);
    expect(result).toMatchObject({ ok: true, verdict: "miss", handover: { state: "skipped" } });
    expect(getRoad(db, "o1")).toMatchObject({ state: "accepted", decided_at: 10 });
    expect(getDecision(db, decisionId)).toMatchObject({ answered_by: "owner", judge_verdict: "miss" });
    expect(JSON.parse(getDecision(db, decisionId)!.answer_json!)).toEqual({ option: "yes", text: "да, делаем" });
    expect(ownerItem(db, proposalItemKey("o1"))!.state).not.toBe("open");
    expect(await lead.decide("o1", "no", undefined, "owner", 11)).toEqual({ ok: false, reason: "branch o1 is accepted, not proposed" });
    expect(await lead.decide("ghost", "no", undefined, "owner", 11)).toEqual({ ok: false, reason: "no branch ghost" });
  });

  it("«да» on a project branch hands it to the project's PM through the intake; without a PM the branch stays accepted and the owner gets one quiet line", async () => {
    const { db, lead, services } = world();
    const handed: unknown[] = [];
    (services as unknown as { phaseIntake: unknown }).phaseIntake = { handOver: async (input: unknown) => { handed.push(input); return { started: true, via: "issue-quick", id: "iq_7" }; } };
    const propose = (id: string, at: number) => {
      addRoad(db, { id, projectId: "proj_1", title: `Branch ${id}`, kind: "direction", source: "lead", why: "evidence here", class: "next_step" }, at);
      openDecision(db, { id: proposalDecisionId(id), surface: "lead", class: "next_step", situation: { title: id }, options: ["yes", "later", "no"] }, at + 1);
      proposeRoad(db, id, proposalDecisionId(id), at + 2);
      postOwnerItem(db, { key: proposalItemKey(id), source: "lead", kind: "proposal", what: id, why: "evidence here" }, at + 2);
    };
    propose("b1", 1);
    const noPm = await lead.decide("b1", "yes", undefined, "screen", 10);
    expect(noPm).toMatchObject({ ok: true, handover: { state: "blocked", reason: "в проекте нет открытого чата Lane Pilot" } });
    expect(getRoad(db, "b1")).toMatchObject({ state: "accepted" });
    expect(ownerItem(db, "lead-handover-blocked:b1")).toMatchObject({ kind: "handover_blocked", state: "open" });
    expect(handed).toHaveLength(0);

    services.workflowTriggers.pmOf = async () => ({ pmThreadId: "thr_pm", runId: "lprun_1" });
    propose("b2", 20);
    const went = await lead.decide("b2", "yes", "да", "screen", 30);
    expect(went).toMatchObject({ ok: true, handover: { state: "started", via: "issue-quick", id: "iq_7" } });
    expect(handed[0]).toMatchObject({ projectId: "proj_1", pmThreadId: "thr_pm", runId: "lprun_1", key: "lead:b2", text: "Branch b2\n\nevidence here" });
    expect(String((handed[0] as { origin: string }).origin)).toContain("by: screen");
    expect(ownerItem(db, "lead-handed:b2")).toMatchObject({ kind: "handed", state: "open" });
    // «нет» and «потом» hand nothing over.
    propose("b3", 40);
    expect(await lead.decide("b3", "later", undefined, "owner", 50)).toMatchObject({ ok: true, handover: null });
    expect(handed).toHaveLength(1);
  });
});

describe("the switch and the state", () => {
  it("setEnabled writes the setting and a design row of the journal; state shows it", async () => {
    const { db, lead } = world();
    const before = await lead.state(1_000);
    expect(before.settings.enabled).toBe(false);
    expect(before.nextTickAt).toBeNull();
    expect(before.rights).toHaveLength(7);
    expect(before.identity.seeded).toBe(true);
    lead.setEnabled(true, "owner", 2_000);
    expect(loadProjectSettings(db, "*")["lead.enabled"]).toBe("on");
    expect(getDecision(db, "lead:enabled:2000")).toMatchObject({ surface: "lead", class: "process", split: "design", answered_by: "owner", judge_verdict: "deferred" });
    const after = await lead.state(3_000);
    expect(after.settings.enabled).toBe(true);
    expect(after.nextTickAt).toBeGreaterThan(3_000);
    expect(after.journal).toMatchObject({ total: 1, exam: 0, backtest: 0 });
  });

  it("setPriority writes the owner's order of projects, deduplicated; an empty call clears it; no journal row", async () => {
    const { db, lead } = world();
    expect(lead.setPriority(["proj_b", " proj_a ", "proj_b", ""])).toEqual(["proj_b", "proj_a"]);
    expect(loadProjectSettings(db, "*")["lead.priority"]).toBe("proj_b,proj_a");
    expect((await lead.state(1_000)).settings.priority).toEqual(["proj_b", "proj_a"]);
    expect(lead.setPriority([])).toEqual([]);
    expect((await lead.state(2_000)).settings.priority).toEqual([]);
    expect((await lead.state(2_000)).journal.total).toBe(0);
  });
});

describe("the model judge on an answer and the owner's labels", () => {
  afterEach(() => setJevForTests(null));
  const seed = (db: ReturnType<typeof openDatabase>, id: string, option: string, at: number) => {
    openDecision(db, { id, surface: "lead", class: "next_step", risk: "low", situation: { title: id }, options: ["yes", "later", "no"] }, at);
    db.prepare("UPDATE lane_pilot_decision SET prediction_json=?, predicted_at=?, predictor='test' WHERE id=?").run(JSON.stringify({ option, p: 0.8 }), at + 1, id);
  };

  it("decide asks the model judge on a mismatch: «yes» to a predicted «later» is a partial when the judge says so", async () => {
    const { db, lead } = world();
    setJevForTests({ enabled: () => true, judge: async (judgment: { id: string }) => judgment.id === "lead.judge" ? { by: "jev", decision: { verdict: "partial" }, receiptId: null, answers: {} } : { by: "fallback", status: "off", decision: { option: null, p: 0 }, receiptId: null } } as never);
    addRoad(db, { id: "d1", title: "Grow", kind: "direction", source: "lead", why: "growth" }, 1);
    addRoad(db, { id: "o9", parentId: "d1", title: "Paid plans", kind: "option", source: "lead", why: "asked twice", class: "next_step" }, 2);
    const decisionId = proposalDecisionId("o9");
    seed(db, decisionId, "later", 3);
    proposeRoad(db, "o9", decisionId, 5);
    postOwnerItem(db, { key: proposalItemKey("o9"), source: "lead", kind: "proposal", what: "Paid plans", why: "asked twice" }, 5);
    expect(await lead.decide("o9", "yes", "да, но после релиза", "owner", 10)).toMatchObject({ ok: true, verdict: "partial" });
    expect(getDecision(db, decisionId)).toMatchObject({ judge_verdict: "partial", judge_model: "jev:lead.judge@1", judged_at: 10 });
  });

  it("labelsDue posts one line a week with up to 20 unlabelled rows and none when nothing waits; label writes the owner's verdict; state counts the rest", async () => {
    const { db, lead } = world();
    const monday = Date.UTC(2026, 10, 2, 10);
    expect(lead.labelsDue(monday)).toEqual({ posted: false, pending: 0 });
    for (let i = 0; i < 22; i += 1) { seed(db, `d${i}`, "yes", 100 + i); answerDecision(db, `d${i}`, { option: i % 2 ? "yes" : "no" }, "owner", 200 + i); }
    seed(db, "proxy", "yes", 300); answerDecision(db, "proxy", { option: "no" }, "lead", 301);
    expect(lead.labelsDue(monday)).toEqual({ posted: true, pending: 20 });
    const line = db.prepare("SELECT kind, state, why FROM lane_pilot_owner_item WHERE key='lead-labels:2026-11-02'").get() as { kind: string; state: string; why: string };
    expect(line).toMatchObject({ kind: "labels", state: "open" });
    expect(line.why.match(/d\d+: прогноз yes, ответ (yes|no), судья (exact|miss)/g)).toHaveLength(3);
    expect(line.why.length).toBeLessThan(600);
    expect(line.why).not.toContain("proxy");
    expect(lead.labelsDue(monday + 60_000)).toEqual({ posted: false, pending: 20 });
    expect(lead.label("d0", "partial", 400)).toBe(true);
    expect(lead.label("ghost", "exact", 400)).toBe(false);
    expect(getDecision(db, "d0")).toMatchObject({ owner_label: "partial", labeled_at: 400 });
    const state = await lead.state(500);
    expect(state.labels.pending).toBe(21);
    expect(state.labels.rows).toHaveLength(20);
    expect(state.labels.rows.map((row) => row.id)).not.toContain("d0");
  });
});

describe("acting through schedules (class schedule, acts_via schedule)", () => {
  it("«да» on a schedule branch creates the schedule in the project's board as the lead; a payload the room refuses, or a script, is one quiet blocked line", async () => {
    const { db, lead, services } = world();
    const saved: Array<{ raw: Record<string, unknown>; by: string }> = [];
    (services as unknown as { schedules: unknown }).schedules = { save: async (raw: Record<string, unknown>, by: string) => {
      saved.push({ raw, by });
      return String(raw.name).startsWith("bad") ? { ok: false, problems: ["when: cron has 4 fields"] } : { ok: true, schedule: { id: "sch_1", name: raw.name }, warnings: [], conflicts: [] };
    } };
    const propose = (id: string, payload: unknown, at: number) => {
      addRoad(db, { id, projectId: "proj_1", title: `Schedule ${id}`, kind: "direction", source: "lead", why: "the nightly scan is missing", class: "schedule", payload }, at);
      openDecision(db, { id: proposalDecisionId(id), surface: "lead", class: "schedule", situation: { title: id }, options: ["yes", "later", "no"] }, at + 1);
      proposeRoad(db, id, proposalDecisionId(id), at + 2);
      postOwnerItem(db, { key: proposalItemKey(id), source: "lead", kind: "proposal", what: id, why: "the nightly scan is missing" }, at + 2);
    };
    propose("s1", { name: "Nightly rules scan", task: { kind: "workflow", workflowId: "lp.rules-scan", inputs: {} }, when: { type: "cron", cron: "0 3 * * *" }, projectId: "proj_other", id: "sch_existing" }, 1);
    expect(getRoad(db, "s1")!.payload_json).toContain("Nightly rules scan");
    const went = await lead.decide("s1", "yes", "да", "owner", 10);
    expect(went).toMatchObject({ ok: true, handover: { state: "started", via: "schedule", id: "sch_1" } });
    // The lead never edits an existing schedule nor writes into another project: id and projectId of the payload are dropped.
    expect(saved[0]).toMatchObject({ by: "lead:owner", raw: { projectId: "proj_1", name: "Nightly rules scan", task: { kind: "workflow", workflowId: "lp.rules-scan" }, when: { type: "cron", cron: "0 3 * * *" } } });
    expect(saved[0]!.raw.id).toBeUndefined();
    expect(String(saved[0]!.raw.description)).toContain("branch s1");
    expect(ownerItem(db, "lead-handed:s1")).toMatchObject({ kind: "handed", state: "open" });
    expect(getRoad(db, "s1")).toMatchObject({ state: "accepted" });

    propose("s2", { name: "bad one", task: { kind: "workflow", workflowId: "x" }, when: { type: "cron", cron: "0 3 * *" } }, 20);
    expect(await lead.decide("s2", "yes", undefined, "owner", 30)).toMatchObject({ ok: true, handover: { state: "blocked", reason: "schedule refused: when: cron has 4 fields" } });
    expect(ownerItem(db, "lead-handover-blocked:s2")).toMatchObject({ kind: "handover_blocked", state: "open" });

    propose("s3", { name: "Host job", task: { kind: "script", command: "rm -rf /" }, when: { type: "cron", cron: "0 3 * * *" } }, 40);
    expect(await lead.decide("s3", "yes", undefined, "owner", 50)).toMatchObject({ ok: true, handover: { state: "blocked", reason: expect.stringContaining("script is a host job") } });
    propose("s4", null, 60);
    expect(await lead.decide("s4", "yes", undefined, "owner", 70)).toMatchObject({ ok: true, handover: { state: "blocked", reason: expect.stringContaining("carries schedule") } });
    expect(saved).toHaveLength(2);
  });
});

describe("the memory exam through the service", () => {
  afterEach(() => setJevForTests(null));
  it("runs on demand, stores the result for the panel and the CLI prints it", async () => {
    const { bb, db, lead } = world();
    setJevForTests({ enabled: () => true, judge: async (_j: unknown, input: { history: Array<{ answer: string }> }) => ({ by: "jev", decision: { option: input.history.length ? input.history[0]!.answer : null, p: 0.9 }, receiptId: null, answers: {} }) } as never);
    for (let i = 0; i < 4; i += 1) {
      openDecision(db, { id: `m${i}`, surface: "words", class: "landing", situation: { task: i }, options: ["yes", "no"] }, 100 + i);
      answerDecision(db, `m${i}`, { option: "yes" }, "owner", 200 + i);
    }
    expect((await lead.state(500)).memoryExam).toBeNull();
    const exam = await lead.memoryExam({ recall: false }, 1_000);
    expect(exam.decisions).toMatchObject({ n: 4, withMemory: { decided: 3, exact: 3 }, control: { decided: 0, exact: 0 }, gain: 3 });
    expect(await bb.storage.kv.get(MEMORY_EXAM_KEY)).toMatchObject({ at: 1_000 });
    expect((await lead.state(2_000)).memoryExam).toMatchObject({ at: 1_000, decisions: { gain: 3 } });
    const cli = await runLeadCli({ db, kv: bb.storage.kv as never, lead }, ["memory-exam", "--no-recall", "--limit", "2"], 3_000);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("decisions (jev): with memory: decided 2/2, exact 2 (100 %); empty control: decided 0/2, exact 0; gain +2");
    expect((await runLeadCli({ db, kv: bb.storage.kv as never, lead }, ["status"], 4_000)).stdout).toContain("memory exam: recall: not measured; decisions (jev)");
    expect((await runLeadCli({ db, kv: bb.storage.kv as never, lead }, ["memory-exam", "--limit", "zero"], 5_000)).exitCode).toBe(2);
  });
});
