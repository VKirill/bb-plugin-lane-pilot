/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { writerCandidates } from "@lane-pilot/models";
import { capOf, moneyCapFrom, moneyHold, spendBook, type DailyRow } from "../../src/rooms/money";
import { createMoney } from "../../src/rooms/money/server";
import { unmeasuredAttempts } from "../../src/rooms/usage/server";
import { laneSessionOverlayPrompt } from "../../src/rooms/native-agent/native-agent-overlay";
import { buildTaskGraph } from "../../src/rooms/runs/server/task-graph";
import { TaskGraphView } from "../../src/rooms/native-agent/ui/task-graph-view";
import { MoneyScreen } from "../../src/rooms/cockpit/ui/screens-day";
import { PROBES, pauseProbeCheck, probeForeignWrites, workspacePorcelain } from "../../src/rooms/native-agent/server/helper-probe";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, setRunObjective, transitionAttempt } from "../../src/rooms/plugin-db";
import { readFileSync } from "node:fs";

afterEach(cleanup);

const NOW = Date.parse("2026-11-10T12:00:00Z");
const day = (offset: number) => new Date(NOW - offset * 86_400_000).toISOString().slice(0, 10);
const row = (providerId: string, inputTokens: number, outputTokens = 0, onDay = day(0)): DailyRow => ({ day: onDay, providerId, model: "m", inputTokens, outputTokens, cachedTokens: 0 });

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb");
  return { bb, db };
}

describe("parity d8: providers and money", () => {
  it("[sma:m_hs_toggle] a writer profile key in writer.models_off drops out of the pick and comes back when the list clears", () => {
    const keys = (settings: Record<string, unknown>) => writerCandidates(settings).map((profile) => profile.key);
    const all = keys({});
    expect(all).toContain("haiku");
    const without = keys({ "writer.models_off": ["haiku"] });
    expect(without).not.toContain("haiku");
    expect(without).toEqual(all.filter((key) => key !== "haiku"));
    expect(keys({ "writer.models_off": [] })).toEqual(all);
  });

  it("[sma:m_cfg_budget0] an unset cap is 0 for a paid lane (money.cap_unset_zero is on unless off), a subscription lane is never held, and 'unlimited' or off lifts it", () => {
    const cap = moneyCapFrom({});
    expect(cap).toBe(0);
    expect(moneyCapFrom({ "money.cap_unset_zero": "on" })).toBe(0);
    // Nothing was spent: the reason says the channel is not configured and names both ways out, not «wait for the next month».
    expect(moneyHold("openlux", 0, cap)).toMatch(/no money cap is set.*monthly cap.*money\.cap_unset_zero=off/);
    expect(moneyHold("openlux", 0, cap)).not.toMatch(/next month/);
    expect(moneyHold("claude-code", 0, cap)).toBeNull();
    expect(moneyCapFrom({ "money.cap_unset_zero": "off" })).toBeNull();
    expect(moneyHold("openlux", 10_000, moneyCapFrom({ "money.cap_unset_zero": "off" }))).toBeNull();
    expect(capOf("unlimited")).toBe(Infinity);
    expect(moneyHold("openlux", 10_000, capOf("unlimited"))).toBeNull();
    expect(moneyCapFrom({ "money.monthly_cap_usd": "unlimited" })).toBe(Infinity);
    expect(moneyCapFrom({ "money.monthly_cap_usd": 25 })).toBe(25);
  });

  it("[sma:m_mo_stop] a paid lane holds when the task's estimate would cross the cap, not only when the month is spent", () => {
    expect(moneyHold("openlux", 9, 10, 2)).toMatch(/estimate of 2\.00 USD/);
    expect(moneyHold("openlux", 9, 10, 0.5)).toBeNull();
    expect(moneyHold("claude-code", 999, 10, 50)).toBeNull();
    expect(moneyHold("openlux", 9, 10, 0)).toBeNull();
  });

  it("[sma:m_mo_series] two paid providers on one day give a series entry whose byProvider holds both amounts and sums to its usd", () => {
    const book = spendBook([row("openlux", 1_000_000), row("anthropic", 1_000_000, 0, day(0))], NOW);
    const today = book.series.find((entry) => entry.day === day(0))!;
    expect(today.byProvider.openlux).toBeCloseTo(0.5);
    expect(today.byProvider.anthropic).toBeCloseTo(3);
    expect(Object.values(today.byProvider).reduce((sum, usd) => sum + usd, 0)).toBeCloseTo(today.usd);
  });

  it("[sma:m_sw_spend_table] spendBook's table holds the last 14 days by day and provider, and the money screen prints a row per day and a column per provider", async () => {
    const book = spendBook([row("openlux", 1_000_000), row("openai", 1_000_000, 0, day(1)), row("openlux", 500_000, 0, day(13))], NOW);
    expect(book.table).toHaveLength(14);
    const day1 = book.table.find((entry) => entry.day === day(1))!;
    expect(day1.byProvider).toEqual({ openai: 2.5 });
    const rpc = { call: async (method: string) => (method === "money_status" ? { monthUsd: book.monthUsd, cap: 10, left: 10 - book.monthUsd, table: book.table } : { at: null, windows: {} }) };
    const view = render(createElement(MoneyScreen, { rpc: rpc as never, hostId: null }));
    await waitFor(() => expect(view.getByTestId("ck-money-table")).toBeTruthy());
    expect(view.getByText("openai")).toBeTruthy();
    expect(view.getByText("openlux")).toBeTruthy();
    expect(view.getByText(day(13))).toBeTruthy();
  });

  it("[sma:m_mo_estimate] a paid-lane attempt with no usage events adds an estimate marked estimated that counts toward the cap", () => {
    const w = world();
    createTask(w.db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1", appetite: { tokens: 1_000_000 } } });
    createAttempt(w.db, { id: "a1", runId: "run", taskId: "t1" });
    w.db.prepare("UPDATE lane_pilot_attempt SET thread_id='thr_silent' WHERE id='a1'").run();
    w.db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,contract_version,state,input_sha256,attempt,provider_id,model,updated_at) VALUES('run','t1','writer-agent',1,'passed','x',0,'openlux','m',?)").run(NOW);
    createTask(w.db, { id: "t2", runId: "run", kind: "bb", contract: { id: "t2" } });
    createAttempt(w.db, { id: "a2", runId: "run", taskId: "t2" });
    w.db.prepare("UPDATE lane_pilot_attempt SET thread_id='thr_measured' WHERE id='a2'").run();
    w.db.prepare("INSERT INTO lane_pilot_token_cursor(thread_id,project_id,provider_id,last_model,last_provider,total_json,updated_at) VALUES('thr_measured','proj','openai','m','openai',?,1)").run(JSON.stringify({ input: 1_000_000, output: 0, total: 1_000_000 }));

    // An attempt still at work has not had its chance to report usage: it is not «silent» yet.
    expect(unmeasuredAttempts(w.db, { sinceMs: 0 })).toEqual([]);
    w.db.prepare("UPDATE lane_pilot_attempt SET state='accepted'").run();
    const silent = unmeasuredAttempts(w.db, { sinceMs: 0 });
    expect(silent.map((attempt) => attempt.attemptId)).toEqual(["a1"]);
    expect(silent[0]!.appetiteTokens).toBe(1_000_000);

    const money = createMoney({ db: w.db, bb: w.bb }).money;
    // The estimate is on without a setting: the task's appetite prices the silent attempt (1M openlux blended = $1).
    expect(money.status(NOW).estimatedUsd).toBeGreaterThan(0);
    saveProjectSetting(w.db, "*", "money.silent_estimate_tokens", 200_000);
    const status = money.status(NOW);
    expect(status.estimated).toBeGreaterThan(0);
    expect(status.estimatedUsd).toBeGreaterThan(0);
    expect(status.monthUsd).toBeGreaterThanOrEqual(status.estimatedUsd);
  });

  it("[sma:k_ag_classifier] doc-classifier names ADR, PRD, SPEC, DOC and unknown and answers a single document with one kind", () => {
    const text = laneSessionOverlayPrompt("doc-classifier");
    for (const kind of ["ADR", "PRD", "SPEC", "DOC", "unknown"]) expect(text).toContain(kind);
    expect(text).toContain("single kind");
    expect(text).toContain("Change nothing");
  });

  it("[sma:k_ag_selector] the selector session and the ai-integration-phase select node score every option per criterion and recommend the highest weighted total", () => {
    const text = laneSessionOverlayPrompt("framework-selector");
    expect(text).toContain("Score");
    expect(text).toContain("matrix");
    expect(text).toContain("weighted total");
    const workflow = JSON.parse(readFileSync("workflows/ai-integration-phase.json", "utf8")) as { nodes: Array<{ id: string; prompt?: string; out?: Record<string, unknown> }> };
    const select = workflow.nodes.find((node) => node.id === "select")!;
    expect(select.prompt).toContain("matrix");
    expect(select.prompt).toContain("0–5");
    expect(select.out).toHaveProperty("scores");
  });

  it("[sma:sc_batch] the run's graph carries the objective, the area composition and the blocked node's reason and attemptId; the view draws the decision buttons on that node only", () => {
    const w = world();
    setRunObjective(w.db, "run", "port the batch");
    createTask(w.db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1", area: "feature:a" } });
    createAttempt(w.db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(w.db, "a1", "spawn_requested");
    transitionAttempt(w.db, "a1", "running");
    createTask(w.db, { id: "t2", runId: "run", kind: "bb", contract: { id: "t2", area: "feature:a" } });
    createAttempt(w.db, { id: "a2", runId: "run", taskId: "t2" });
    transitionAttempt(w.db, "a2", "spawn_requested");
    transitionAttempt(w.db, "a2", "running");
    transitionAttempt(w.db, "a2", "blocked", { reason: "verify_passes_exhausted" });
    createTask(w.db, { id: "t3", runId: "run", kind: "bb", contract: { id: "t3", depends_on: ["t2"], area: "feature:a" } });
    createAttempt(w.db, { id: "a3", runId: "run", taskId: "t3" });

    const graph = buildTaskGraph(w.db, "run");
    expect(graph.objective).toBe("port the batch");
    expect(graph.nodes.filter((node) => node.area === "feature:a")).toHaveLength(3);
    const blocked = graph.nodes.find((node) => node.id === "t2")!;
    expect(blocked.state).toBe("blocked");
    expect(blocked.reason).toBe("verify_passes_exhausted");
    expect(blocked.attemptId).toBe("a2");

    const view = render(createElement(TaskGraphView, { graph, onRetry: () => undefined, onCancel: () => undefined }));
    expect(view.getByTestId("task-graph-scope").textContent).toContain("port the batch");
    expect(view.getByTestId("task-retry-t2")).toBeTruthy();
    expect(view.getByTestId("task-cancel-t2")).toBeTruthy();
    expect(view.queryByTestId("task-retry-t1")).toBeNull();
  });
});

describe("parity d8: capability drills", () => {
  const done = [
    { type: "turn/started", seq: 1, createdAt: Date.now(), threadId: "thr", data: {} },
    { type: "turn/completed", seq: 2, createdAt: Date.now(), threadId: "thr", data: { status: "completed" } },
  ];
  const fakeBb = (events: unknown[]) => ({
    sdk: {
      threads: {
        events: { list: async () => events },
        get: async () => ({ status: "idle" }),
        listRunning: async () => [],
        stop: async () => ({}),
        send: async () => ({}),
        output: async () => ({ output: "RESUMED" }),
        archive: async () => ({}),
      },
    },
    hosts: { experimental_client: () => ({ call: async () => ({ stdout: "" }) }) },
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
  });

  it("[sma:m_pr_doc_drill] the nested probe passes only when a tool call ran `bb lane-pilot status` — the prompt and the model's own words do not count", async () => {
    const nested = (PROBES["documentary.nested"] as { check: (args: never) => Promise<{ ok: boolean; reason?: string }> }).check;
    const args = (events: unknown[]) => ({ bb: fakeBb(events), threadId: "thr", hostId: "h", workspace: "/w", output: "NESTED" }) as never;
    // What a real thread always holds: the prompt (which names the command) and the reply that claims it.
    const words = [
      { type: "item/completed", data: { item: { type: "userMessage", text: PROBES["documentary.nested"].prompt } } },
      { type: "item/completed", data: { item: { type: "agentMessage", text: "I ran `bb lane-pilot status`. NESTED" } } },
    ];
    const bad = await nested(args(words));
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("bb lane-pilot status");
    const good = await nested(args([...words, { type: "item/completed", data: { item: { type: "commandExecution", command: "bb lane-pilot status" } } }]));
    expect(good.ok).toBe(true);
    // The role probe asks for a word the prompt itself names: a session is never told its role name, so a probe that
    // wanted the name back was red on every provider (live hub, 0.1.520). The proof of the role is the spawn metadata check.
    expect(PROBES["documentary.role"].prompt).not.toContain("pm-reader");
    expect(PROBES["documentary.role"].expect.test("ROLE")).toBe(true);
    expect(PROBES["documentary.role"].prompt).toContain("ROLE");
    expect(String(PROBES["documentary.role"].expect)).not.toContain("pm-reader");
  });

  it("[sma:m_pr_claude_pause] a thread that stops, is confirmed stopped and answers RESUMED on the same id passes pause; one still running fails with the step named", async () => {
    const stopped = fakeBb(done);
    expect(await pauseProbeCheck(stopped as never, "thr", 100)).toEqual({ ok: true });
    const calls: string[] = [];
    const still = fakeBb([]);
    still.sdk.threads.get = async () => { calls.push("get"); return { status: "running" }; };
    const verdict = await pauseProbeCheck(still as never, "thr", 100);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("pause:stop");
  });

  it("[sma:m_pr_codex_pause] the same stop-confirm-resume proof is the pause drill for every provider — it stops mid-command, no turn boundary needed", async () => {
    const order: string[] = [];
    const bb = fakeBb(done);
    bb.sdk.threads.stop = async () => { order.push("stop"); return {}; };
    bb.sdk.threads.send = async () => { order.push("send"); return {}; };
    const verdict = await pauseProbeCheck(bb as never, "thr", 100);
    expect(verdict).toEqual({ ok: true });
    expect(order).toEqual(["stop", "send"]);
  });

  it("[sma:m_pr_codex_probe] a workspace with a new untracked file that is not .lp-probe-* fails the sandbox check; a clean one passes", async () => {
    const wrote = fakeBb([]);
    wrote.hosts.experimental_client = () => ({ call: async () => ({ stdout: "?? src/hacked.ts\n?? .lp-probe-gate\n" }) });
    const after = await workspacePorcelain(wrote as never, "h", "/w");
    expect(after).not.toBeNull();
    const foreign = probeForeignWrites(new Set(), after!);
    expect(foreign).toEqual(["src/hacked.ts"]);
    const clean = fakeBb([]);
    const afterClean = await workspacePorcelain(clean as never, "h", "/w");
    expect(probeForeignWrites(new Set(), afterClean!)).toEqual([]);
  });
});
