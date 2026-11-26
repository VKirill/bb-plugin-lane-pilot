import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { maybeNotifyWorkflowRun, notifyWorkflowIfEnded } from "../../src/rooms/workflow/server/services/pm-notice";
import { SCOUT_GRAPH } from "../../src/rooms/critique/server";
import { beginWorkflowWait, beginWriterWait, isWriterWaitActive, noteWorkflowFollowedByPm, noteWorkflowReadByPm } from "../../src/rooms/platform/server";
import { isServiceNoticeText } from "../../src/rooms/contracts/service-notice";
import { SCHEDULE_RUN_KEY_PREFIX } from "../../src/rooms/contracts";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import { parseWorkflow } from "@lane-pilot/workflow-engine";
import type { RunRow } from "../../src/rooms/plugin-db";
import { engineOn, journalDb, ok, wf } from "../workflow/engine-helpers";

const projectId = "notice-project";
const pmThreadId = "notice-pm";
const runId = "notice-run";
afterEach(() => forgetSecrets());

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

describe("workflow PM notices", () => {
  it.each([null, false, 0, { detail: "unknown" }])("retains a non-string status %j", async (status) => {
    const { bb, sends } = noticeBb();
    await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: runRow({ output_json: JSON.stringify({ status }) }) });
    expect(sends[0]!.text).toContain("### status");
    expect(sends[0]!.text).toContain(JSON.stringify(status, null, 2));
    expect(sends[0]!.text).not.toContain("no output");
  });
  it("renders an errand report as Markdown without escaping paragraphs or hiding its recorded checks", async () => {
    const { bb, sends } = noticeBb();
    const output = { state: "done", output: "**Part A**\n\n- [Receipt](https://example.com/receipt)\n- checked", checks: [{ ok: true, detail: "verified" }], thread_id: "thr_result" };
    await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: runRow({ output_json: JSON.stringify(output) }) });
    const text = sends[0]!.text;
    expect(text).toContain("## Lane Pilot · demo");
    expect(text).toContain("**Part A**\n\n- [Receipt](https://example.com/receipt)");
    expect(text).not.toContain('\\n');
    expect(text).toContain('"ok": true');
    expect(text).toContain("thr_result");
  });
  it("tells the PM once how a chat-started run ended: the report on success, the actual output or reason otherwise", async () => {
    const { bb, sends, kv } = noticeBb();
    const report = runRow({ id: "wfrun_report", output_json: JSON.stringify({ report_md: "weekly digest" }) });
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: report })).toBe(true);
    expect(sends[0]!.text).toContain("weekly digest");
    expect(sends[0]!.text).toContain("wfrun_report");
    // Preserve business status even after a long report; mask a remembered secret with no recognizable key shape.
    const secret = "opaque-notice-credential-37";
    registerSecrets([secret]);
    const partial = runRow({ id: "wfrun_partial", output_json: JSON.stringify({ opaque: secret, report_md: "half an answer [lane-pilot-selection:68b66b18-ce7b-4e1b-a2c0-77a6ec14b1e9] " + "x".repeat(13_000), status: "partial" }) });
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: partial })).toBe(true);
    expect(sends[1]!.text).toContain("half an answer");
    expect(sends[1]!.text).not.toContain("lane-pilot-selection");
    expect(sends[1]!.text).not.toContain(secret);
    expect(sends[1]!.text).toContain("Output status: partial");
    expect(sends[1]!.text.length).toBeLessThan(12_300);
    const bare = runRow({ id: "wfrun_bare" });
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: bare })).toBe(true);
    expect(sends[2]!.text).toContain("no output");
    for (const [status, reason] of [["failed", "boom"], ["blocked", "goal_audit: not met: g2"], ["canceled", "owner stop"], ["interrupted", "host lost"]] as const) {
      const told = await maybeNotifyWorkflowRun({
        bb, log: () => undefined, pmThreadId, startedBySchedule: false,
        run: runRow({ id: `wfrun_${status}`, status, reason }),
        unmetGoalIds: status === "blocked" ? ["g2"] : undefined,
      });
      expect(told).toBe(true);
    }
    const texts = sends.map((s) => s.text);
    expect(texts.join("\n")).toContain("ended failed");
    expect(texts.join("\n")).toContain("Reason: boom");
    expect(sends.find((s) => s.text.includes("wfrun_blocked"))!.text).toContain("Unmet goals: g2");
    // The notice is once per end state: a repeated terminal event for the same run sends nothing more.
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: report })).toBe(false);
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: runRow({ id: "wfrun_unlinked", link_run_id: null }) })).toBe(false);
    expect(sends).toHaveLength(7);
    expect(kv.size).toBe(7);
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

  it("delivers a scheduled run's report once per terminal state", async () => {
    const { bb, sends } = noticeBb();
    const input = {
      bb, log: () => undefined, pmThreadId, startedBySchedule: true,
      run: runRow({ id: "wfrun_r", output_json: JSON.stringify({ report_md: "weekly digest" }) }),
    };
    expect(await maybeNotifyWorkflowRun(input)).toBe(true);
    expect(await maybeNotifyWorkflowRun(input)).toBe(false);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("weekly digest");
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
    // The engine's terminal event reaches the notify boundary: a chat-started linked run's end tells the PM once per state.
    expect(await notifyWorkflowIfEnded({ bb, db, log: () => undefined, run: row })).toBe(true);
    expect(sends).toHaveLength(1);
    for (const status of ["canceled", "blocked", "failed"] as const) {
      db.prepare("UPDATE lane_pilot_wf_run SET status=?, reason=? WHERE id=?").run(status, "test end", linked.runId);
      const ended = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(linked.runId) as RunRow;
      expect(await notifyWorkflowIfEnded({ bb, db, log: () => undefined, run: ended, unmetGoalIds: status === "blocked" ? ["g1"] : undefined })).toBe(true);
    }
    expect(sends).toHaveLength(4);
    expect(sends.join("\n")).toContain("ended failed");
    // A schedule-started run still delivers only its report: a failed one with none sends nothing.
    db.prepare("UPDATE lane_pilot_wf_run SET status='succeeded', idem_key=? WHERE id=?").run(`${SCHEDULE_RUN_KEY_PREFIX}job`, linked.runId);
    const scheduled = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(linked.runId) as RunRow;
    expect(await notifyWorkflowIfEnded({ bb, db, log: () => undefined, run: { ...scheduled, status: "failed", reason: "boom" } })).toBe(false);
    expect(sends).toHaveLength(4);
    await harness.lifecycle.dispose();
  });

  it("claims one notice per terminal transition: a concurrent event burst sends once, a real re-run failure sends again", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    // Deferred kv: the end of a run fires several journal events back to back, and a fast store can hide
    // the check-then-set race the burst exposes.
    const kv = bb.storage.kv;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const burstBb = {
      ...bb,
      storage: {
        ...bb.storage,
        kv: {
          get: async <T>(key: string): Promise<T | undefined> => { await tick(); return kv.get<T>(key); },
          set: async (key: string, value: unknown) => { await tick(); await kv.set(key, value); },
          delete: (key: string) => kv.delete(key),
          list: (prefix?: string) => kv.list(prefix),
        },
      },
    };
    const sends: string[] = [];
    harness.sdk.stub("threads.send", async (args: unknown) => { sends.push((args as { input: Array<{ text: string }> }).input[0]!.text); });
    const engine = engineOn(db, {
      search: ok(() => ({ items: ["a"], count: 1, kind: "fresh" })),
      write: { reentrant: true, run: async () => { throw new Error("HTTP 400: Required"); } },
    });
    const linked = await engine.start({ workflow: wf(), inputs: { query: "q" }, link: { projectId, runId } }).done;
    const row = () => db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(linked.runId) as RunRow;
    expect(row().status).toBe("failed");
    const notify = () => notifyWorkflowIfEnded({ bb: burstBb, db, log: () => undefined, run: row() });
    // Every journal row of the terminal burst reaches the notifier with the same status snapshot.
    await Promise.all([notify(), notify(), notify()]);
    expect(sends).toHaveLength(1);
    // A real re-run that fails the same way is a new transition, not a duplicate: it earns its own notice.
    expect(await engine.rerunNode(linked.runId, "write")).toMatchObject({ ok: true });
    for (let i = 0; i < 200 && row().status !== "failed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(row().status).toBe("failed");
    await notify();
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain("ended failed");
    await harness.lifecycle.dispose();
  });
});

describe("lead hand-over runs", () => {
  it("send nothing to the borrowed PM chat: the end goes back to the lead's road", async () => {
    const { addRoad, getRoad, listRoad, proposeRoad, reopenRoad } = await import("../../src/rooms/lead/server/repositories/road-repository");
    const roadApi = { addRoad, getRoad, listRoad, doneRoad: (await import("../../src/rooms/lead/server/repositories/road-repository")).doneRoad, reopenRoad };
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const sends: string[] = [];
    harness.sdk.stub("threads.send", async (args: unknown) => { sends.push((args as { input: Array<{ text: string }> }).input[0]!.text); });
    const accepted = () => {
      const road = addRoad(db, { projectId, title: "fix the red test", kind: "direction", source: "lead", why: "the gate went red" });
      proposeRoad(db, road.id, `lead:${road.id}`);
      db.prepare("UPDATE lane_pilot_lead_road SET state='accepted' WHERE id=?").run(road.id);
      return road.id;
    };
    const blockedId = accepted();
    const blocked = runRow({ idem_key: `intake:${pmThreadId}:lead:${blockedId}`, workflow_id: "issue-quick", status: "blocked", reason: "goal_audit: not met: request" });
    expect(await notifyWorkflowIfEnded({ bb, db, leadRoad: roadApi, log: () => undefined, run: blocked, unmetGoalIds: ["request"] })).toBe(false);
    expect(getRoad(db, blockedId)!.state).toBe("open");
    expect(getRoad(db, blockedId)!.why).toContain("goal_audit: not met: request");
    const doneId = accepted();
    expect(await notifyWorkflowIfEnded({ bb, db, leadRoad: roadApi, log: () => undefined, run: runRow({ idem_key: `intake:${pmThreadId}:lead:${doneId}`, workflow_id: "issue-quick" }) })).toBe(false);
    expect(getRoad(db, doneId)!.state).toBe("done");
    expect(sends).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item").get()).toMatchObject({ n: 0 });
    await harness.lifecycle.dispose();
  });

  it("suppresses duplicate PM notices when a synchronous wait tool is actively waiting on or already read the workflow run", async () => {
    const { bb, sends } = noticeBb();
    const endWait = beginWorkflowWait("wfrun_waited_1");
    try {
      expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: runRow({ id: "wfrun_waited_1", workflow_id: "specialist", output_json: JSON.stringify({ report: "done" }) }) })).toBe(false);
    } finally {
      endWait();
    }
    noteWorkflowReadByPm("wfrun_read_1");
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: runRow({ id: "wfrun_read_1", workflow_id: "errand", output_json: JSON.stringify({ state: "done", output: "ok" }) }) })).toBe(false);
    noteWorkflowReadByPm("wfrun_scout_1");
    expect(await maybeNotifyWorkflowRun({ bb, log: () => undefined, pmThreadId, startedBySchedule: false, run: runRow({ id: "wfrun_scout_1", workflow_id: SCOUT_GRAPH, output_json: JSON.stringify({ report: "ok" }) }) })).toBe(false);
    expect(sends).toEqual([]);
  });

  it("holds a followed run's notice through the gap between two wait calls and sends it only when the PM's turn ends unread", async () => {
    const { bb, sends } = noticeBb();
    let status = "running";
    const busyBb = { ...bb, sdk: { threads: { ...bb.sdk.threads, get: async () => ({ status }) } } };
    // Live 2026-11-24: the first wait_errand returned at its limit just before the run ended; the second one read the end 4 s later.
    beginWorkflowWait("wfrun_gap_1")();
    const decided = maybeNotifyWorkflowRun({ bb: busyBb, log: () => undefined, pmThreadId, startedBySchedule: false, followWaitMs: 5_000,
      run: runRow({ id: "wfrun_gap_1", workflow_id: "errand", output_json: JSON.stringify({ state: "done", output: "act sent" }) }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    noteWorkflowReadByPm("wfrun_gap_1");
    expect(await decided).toBe(false);

    beginWorkflowWait("wfrun_gap_2")();
    const unread = maybeNotifyWorkflowRun({ bb: busyBb, log: () => undefined, pmThreadId, startedBySchedule: false, followWaitMs: 5_000,
      run: runRow({ id: "wfrun_gap_2", workflow_id: "errand", output_json: JSON.stringify({ state: "done", output: "act sent" }) }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = "idle";
    expect(await unread).toBe(true);
    expect(sends.map((send) => send.text)).toEqual([expect.stringContaining("wfrun_gap_2")]);

    // lane_pilot_workflow_status polling a running run follows it the same way.
    status = "running";
    noteWorkflowFollowedByPm("wfrun_gap_3");
    const polled = maybeNotifyWorkflowRun({ bb: busyBb, log: () => undefined, pmThreadId, startedBySchedule: false, followWaitMs: 5_000,
      run: runRow({ id: "wfrun_gap_3", workflow_id: "demo", output_json: JSON.stringify({ report: "ok" }) }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    noteWorkflowReadByPm("wfrun_gap_3");
    expect(await polled).toBe(false);
    expect(sends).toHaveLength(1);
  });

  it("tracks active lane_pilot_wait_writer calls and recognizes owner-ask and post-merge gate service notices", () => {
    expect(isWriterWaitActive("pm-wait-1")).toBe(false);
    const endWriterWait = beginWriterWait("pm-wait-1");
    expect(isWriterWaitActive("pm-wait-1")).toBe(true);
    endWriterWait();
    expect(isWriterWaitActive("pm-wait-1")).toBe(false);

    expect(isServiceNoticeText("Lane Pilot: the owner answered your question (ask_1): yes")).toBe(true);
    expect(isServiceNoticeText("Lane Pilot: проверка после вливания на main упала")).toBe(true);
    expect(isServiceNoticeText("Делай всё что считаешь нужным")).toBe(false);
  });

  it("closes explicit non-fulfillment request-goal runs without goal_audit LLM calls and wires writer-outcome boundaries", async () => {
    const audited: string[] = [];
    const proposeChain = parseWorkflow({
      id: "propose-exit",
      name: { en: "Propose exit", ru: "Предложение" },
      description: { en: "Exits proposed", ru: "Выходит с предложением" },
      inputs: {},
      outputs: { status: "string" },
      entry: "prep",
      nodes: [
        { id: "prep", type: "action", action: "mark", out: { ready: "bool" } },
        { id: "done", type: "action", action: "emit", map: { status: "proposed" } },
      ],
      edges: [{ from: "prep", to: "done" }],
    });
    const engine = engineOn(journalDb(), { mark: ok(() => ({ ready: true })) }, {
      auditGoals: async (input) => {
        audited.push(String(input.output.status));
        return { met: [], unmet: [{ id: "request", why: "should not audit non-fulfillment exit" }] };
      },
    });
    const result = await engine.start({
      workflow: proposeChain,
      inputs: {},
      goals: [{ id: "request", done_when: "Plan feature", evidence: "tasks", guess: true }],
    }).done;
    expect(result).toMatchObject({ status: "succeeded" });
    expect(audited).toEqual([]);
  });
});
