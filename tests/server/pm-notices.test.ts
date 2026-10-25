import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, savePrototypeConfig, setRunThread } from "../../src/rooms/storage/database";
import { councilDecisionText, councilEndedText, sendCouncilNotice } from "../../src/rooms/council/server/pm-notice";
import { maybeNotifyWorkflowRun, notifyWorkflowIfEnded, workflowEndedText } from "../../src/rooms/workflow/server/pm-notice";
import { SCHEDULE_RUN_KEY_PREFIX } from "../../src/rooms/workflow/server/workflow-runtime";
import type { RunRow } from "../../src/rooms/storage";
import { engineOn, ok, wf } from "../workflow/engine-helpers";

const projectId = "notice-project";
const pmThreadId = "notice-pm";
const runId = "notice-run";
const workspace = "/tmp/notice-workspace";

function noticeBb() {
  const sends: Array<{ threadId: string; mode: string; text: string }> = [];
  const kv = new Map<string, unknown>();
  const bb = {
    sdk: {
      threads: {
        send: async (request: { threadId: string; mode: string; input: Array<{ text: string }> }) => {
          sends.push({ threadId: request.threadId, mode: request.mode, text: request.input[0]!.text });
        },
      },
    },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key) ?? null,
        set: async (key: string, value: unknown) => { kv.set(key, value); },
      },
    },
  };
  return { bb, sends, kv };
}

const runRow = (patch: Partial<RunRow> = {}): RunRow => ({
  id: "wfrun_1", idem_key: "wf:notice-run:demo:aaaa", workflow_id: "demo", workflow_version: 1, workflow_sha256: "a", definition_json: "{}",
  project_id: projectId, link_run_id: runId, link_task_id: null, link_attempt_id: null, parent_run_id: null, parent_step_key: null, depth: 0,
  status: "succeeded", reason: null, mode: null, inputs_json: "{}", output_json: null, harness_version: "test",
  steps_used: 1, tokens_used: 0, cost_micro_usd: 0, wait_ms: 0, owner_id: null, lease_until: 0, created_at: 1, updated_at: 1,
  ...patch,
});

describe("council PM notices", () => {
  it("names the council, question, decision page, next tasks and what to do", () => {
    const text = councilDecisionText({
      id: "cncl_abc", question: "How to raise repeat purchases?", decisionPath: "docs/decisions/2026-10-14-council-repeat.md",
      nextTasks: [{ title: "Guest checkout", toAgent: "writer" }],
    });
    expect(text).toContain("Council cncl_abc decided.");
    expect(text).toContain("Question: How to raise repeat purchases?");
    expect(text).toContain("Decision page: docs/decisions/2026-10-14-council-repeat.md");
    expect(text).toContain("- Guest checkout → writer");
    expect(text).toContain("Dispatch the tasks it names, or report the decision to the owner.");
  });

  it("sends one short message when the council ends without a decision", () => {
    const text = councilEndedText({ id: "cncl_abc", question: "How to raise repeat purchases?", state: "failed", reason: "stopped by the owner" });
    expect(text).toContain("ended without a decision");
    expect(text).toContain("cncl_abc");
    expect(text).toContain("How to raise repeat purchases?");
  });

  it("delivers a council notice once per terminal state", async () => {
    const { bb, sends } = noticeBb();
    const input = { bb, pmThreadId, councilId: "cncl_1", state: "done" as const, text: "decided", log: () => undefined };
    expect(await sendCouncilNotice(input)).toBe(true);
    expect(await sendCouncilNotice(input)).toBe(false);
    expect(sends).toEqual([{ threadId: pmThreadId, mode: "queue-if-active", text: "decided" }]);
  });
});

describe("workflow PM notices", () => {
  it("names the run, workflow, status, reason and the status tool", () => {
    const text = workflowEndedText({ workflowRunId: "wfrun_1", workflowId: "demo", status: "succeeded", reason: null });
    expect(text).toContain("Workflow run wfrun_1 of demo is succeeded.");
    expect(text).toContain("lane_pilot_workflow_status");
  });

  it("sends a succeeded notice to the PM chat", async () => {
    const { bb, sends } = noticeBb();
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, run: runRow(), pmThreadId, startedBySchedule: false })).toBe(true);
    expect(sends[0]).toMatchObject({ threadId: pmThreadId, mode: "queue-if-active" });
    expect(sends[0]!.text).toContain("wfrun_1");
    expect(sends[0]!.text).toContain("succeeded");
  });

  it("sends a blocked notice with unmet goal ids", async () => {
    const { bb, sends } = noticeBb();
    await maybeNotifyWorkflowRun({
      bb, log: () => undefined, pmThreadId, startedBySchedule: false,
      run: runRow({ status: "blocked", reason: "goal_audit: not met: g2" }),
      unmetGoalIds: ["g2"],
    });
    expect(sends[0]!.text).toContain("blocked");
    expect(sends[0]!.text).toContain("Reason: goal_audit: not met: g2");
    expect(sends[0]!.text).toContain("Unmet goals: g2");
  });

  it("hands the PM the report a scheduled run was for, to show the owner as it is; nothing for a scheduled run without one", async () => {
    const { bb, sends } = noticeBb();
    const report = runRow({ id: "wfrun_r", output_json: JSON.stringify({ status: "reported", report_md: "## Изменения за неделю\n- README.md" }) });
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, run: report, pmThreadId, startedBySchedule: true })).toBe(true);
    expect(sends[0]!.text).toContain("## Изменения за неделю");
    expect(sends[0]!.text).toContain("as it is");
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, run: runRow({ id: "wfrun_f", status: "failed", output_json: JSON.stringify({ report_md: "x" }) }), pmThreadId, startedBySchedule: true })).toBe(false);
  });

  it("sends no notice for a phase's stage run: it reports through the phase's gates", async () => {
    const { bb, sends } = noticeBb();
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, run: runRow({ idem_key: "phase:ph_1:plan:1:1" }), pmThreadId, startedBySchedule: false })).toBe(false);
    expect(sends).toEqual([]);
  });

  it("sends no notice for a schedule-started run or a run with no PM chat", async () => {
    const { bb, sends } = noticeBb();
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, run: runRow(), pmThreadId, startedBySchedule: true })).toBe(false);
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, run: runRow(), pmThreadId: null, startedBySchedule: false })).toBe(false);
    expect(sends).toEqual([]);
  });

  it("delivers a workflow notice once per terminal state", async () => {
    const { bb, sends } = noticeBb();
    const input = { bb, log: () => undefined, run: runRow(), pmThreadId, startedBySchedule: false };
    expect(await maybeNotifyWorkflowRun(input)).toBe(true);
    expect(await maybeNotifyWorkflowRun(input)).toBe(false);
    expect(sends).toHaveLength(1);
  });

  it("looks up the PM thread from the linked Lane Pilot run and skips a schedule key", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const engine = engineOn(db, { search: ok(() => ({ items: ["a"], count: 1, kind: "fresh" })), write: ok(() => ({ text: "ok" })) });
    const linked = await engine.start({ workflow: wf(), inputs: { query: "q" }, link: { projectId, runId } }).done;
    const row = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(linked.runId) as RunRow;
    const sends: string[] = [];
    harness.sdk.stub("threads.send", async (args: unknown) => { sends.push((args as { input: Array<{ text: string }> }).input[0]!.text); });
    expect(await notifyWorkflowIfEnded({ bb, db, log: () => undefined, run: row })).toBe(true);
    expect(sends[0]).toContain(linked.runId);
    expect(await notifyWorkflowIfEnded({ bb, db, log: () => undefined, run: row })).toBe(false);
    db.prepare("UPDATE lane_pilot_wf_run SET idem_key=? WHERE id=?").run(`${SCHEDULE_RUN_KEY_PREFIX}job`, linked.runId);
    const scheduled = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(linked.runId) as RunRow;
    expect(await notifyWorkflowIfEnded({ bb, db, log: () => undefined, run: { ...scheduled, status: "failed", reason: "boom" } })).toBe(false);
    expect(sends).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});

describe("council start reports the decision to the PM chat", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  it("sends one decision notice after the council writes its page", async () => {
    const sends: Array<{ threadId: string; text: string; mode: string }> = [];
    const meta = new Map<string, Record<string, unknown>>();
    const agendaJson = JSON.stringify({ agenda: ["Where do buyers stop?"], criteria: ["effect on sales"] });
    const decisionJson = JSON.stringify({
      summary: "Buyers stop at payment.",
      options: [{ title: "Guest checkout", expectedImpact: "faster first purchase", effort: "low", confidence: "high", evidence: [] }],
      recommendation: "Ship guest checkout first.",
      dissent: [], experiments: [],
      nextTasks: [{ title: "Guest checkout", objective: "Let a visitor buy without an account.", acceptance: ["No account form before payment"], toAgent: "writer" }],
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : meta.get(threadId) ?? {},
          spawn: async (args) => {
            const request = args as unknown as Record<string, unknown>;
            const id = `seat-${meta.size + 1}`;
            meta.set(id, (request.pluginMetadata as Record<string, unknown>) ?? {});
            return { id };
          },
          get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
          events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async ({ threadId }) => {
            const m = meta.get(threadId) ?? {};
            const round = Number(m.round);
            if (m.seatId === "chair") return { output: round === 0 ? `\`\`\`json\n${agendaJson}\n\`\`\`` : decisionJson };
            if (round === 1) return { output: `${String(m.seatId)}: position on payment.` };
            return { output: "PASS" };
          },
          send: async (args: unknown) => {
            const request = args as { threadId: string; mode: string; input: Array<{ text?: string }> };
            sends.push({ threadId: request.threadId, mode: request.mode, text: request.input[0]?.text ?? "" });
          },
          stop: async () => ({ ok: true }) as never,
          list: async () => [...meta.keys()].map((id) => ({ id })) as never,
        },
        providers: { list: async () => [] as never, models: async () => ({ models: [] }) as never },
        files: { read: async () => ({ content: null }) as never, write: async () => ({ ok: true }) as never },
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: workspace, writerWorkspacePath: workspace, pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const call = async (name: string, params: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;
    const started = await call("lane_pilot_council_start", { runId, question: "Как поднять повторные покупки в кабинете?", roles: ["product", "skeptic"], maxRounds: 2, mode: "rounds", judge: false });
    let view: Record<string, any> = started;
    for (let i = 0; i < 100 && !["done", "failed", "stopped"].includes(view.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      view = await call("lane_pilot_council_status", { runId, councilId: started.id });
    }
    expect(view.state).toBe("done");
    for (let i = 0; i < 40 && !sends.some((item) => item.text.includes("decided")); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const notice = sends.find((item) => item.text.includes("decided"));
    expect(notice).toMatchObject({ threadId: pmThreadId, mode: "queue-if-active" });
    expect(notice!.text).toContain(started.id);
    expect(notice!.text).toContain(view.decisionPath);
    expect(notice!.text).toContain("Guest checkout → writer");
    expect(sends.filter((item) => item.text.includes("decided"))).toHaveLength(1);
  });
});
