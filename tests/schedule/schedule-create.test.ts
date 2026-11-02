import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, registerPureActions } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/storage/database";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { registerAgentRoutineActions } from "../../src/rooms/schedule/server/schedule-agent-actions";
import { parseMoment, wallClock } from "../../src/rooms/schedule/time";

/**
 * `schedule.create` through the real engine on telegram-send: a send_at puts one run of the graph on the board (the owner's zone, the run's
 * inputs minus send_at, allowed as a first live run) and the run ends scheduled; a text that is no time, or a board that refuses, ends
 * cannot_delay and schedules nothing. Without send_at the step is skipped and the send runs.
 */
const ZONE = "Europe/Madrid";
type Save = (raw: unknown, by: string) => Promise<unknown>;

function world(save?: Save) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const saves: Array<{ raw: any; by: string }> = [];
  const services = { schedules: { save: vi.fn(async (raw: unknown, by: string) => { saves.push({ raw, by }); return save ? save(raw, by) : { ok: true, schedule: { id: "sch-1" }, warnings: [], conflicts: [] }; }) } } as never;
  const ctx = { db, bb: { log: { warn: vi.fn(), info: vi.fn() } } } as never;
  const engine = new WorkflowEngine({ db, harnessVersion: "test" });
  registerPureActions(engine);
  const sends: unknown[] = [];
  engine.register("agent", { reentrant: true, run: async (c: any) => { sends.push(c.input.with); return { output: { status: "sent", message_id: "m-1", message_url: "", reason: "", handoff: "sent" } }; } });
  engine.register("telegram.send_rich", { reentrant: true, run: async () => ({ output: { message_id: "", status: "ok" } }) });
  registerAgentRoutineActions(engine, ctx, services);
  const run = async (inputs: Record<string, unknown>) => {
    const started = engine.start({ workflow: builtinWorkflow("telegram-send")!, inputs: { chat: "@ivan", text: "доброе утро", file_path: "", report_chat: "", ...inputs }, runtime: { ctx, services, pmThreadId: null, projectId: "p1", runId: null } as never });
    return { summary: await started.done, runId: started.runId };
  };
  return { run, saves, sends };
}

describe("schedule.create", () => {
  it("reads a delay, a local wall time and an instant; refuses the rest", () => {
    const now = Date.UTC(2026, 10, 2, 12);
    expect(parseMoment("+2h", now, ZONE)).toBe(now + 2 * 3_600_000);
    expect(parseMoment("30m", now, ZONE)).toBe(now + 1_800_000);
    expect(parseMoment("2026-11-03T07:00", now, ZONE)).toBe(Date.UTC(2026, 10, 3, 6));
    expect(parseMoment("2026-07-03 07:00", now, ZONE)).toBe(Date.UTC(2026, 6, 3, 5));
    expect(parseMoment("2026-11-03T06:00:00Z", now, ZONE)).toBe(Date.UTC(2026, 10, 3, 6));
    expect(parseMoment("tomorrow morning", now, ZONE)).toBeNull();
    expect(wallClock(Date.UTC(2026, 10, 3, 6), ZONE)).toBe("2026-11-03 07:00");
  });

  it("send_at: one run of the graph goes on the board in the owner's zone, without send_at, allowed as a first live run; the run ends scheduled", async () => {
    const w = world();
    const { summary, runId } = await w.run({ send_at: "2026-11-03T07:00" });
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "scheduled", schedule_id: "sch-1", run_at: "2026-11-03 07:00", send_at: "2026-11-03T07:00" });
    expect(w.saves).toHaveLength(1);
    expect(w.saves[0]!.by).toBe(`workflow:${runId}`);
    expect(w.saves[0]!.raw).toEqual({
      projectId: "p1", name: "Telegram → @ivan",
      task: { kind: "workflow", workflowId: "telegram-send", inputs: { chat: "@ivan", text: "доброе утро", file_path: "", report_chat: "" }, liveTrial: true },
      when: { type: "once", runAt: Date.UTC(2026, 10, 3, 6) },
    });
    expect(w.sends).toHaveLength(0);
  });

  it("a delay counts from now", async () => {
    const w = world();
    const before = Date.now();
    const { summary } = await w.run({ send_at: "+2h" });
    expect(summary.output).toMatchObject({ status: "scheduled" });
    const runAt = w.saves[0]!.raw.when.runAt as number;
    expect(runAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
    expect(runAt).toBeLessThan(before + 2 * 3_600_000 + 10_000);
  });

  it("a text that is no time, or a board that refuses, ends cannot_delay and schedules nothing", async () => {
    const w = world();
    const { summary } = await w.run({ send_at: "tomorrow morning" });
    expect(summary.output).toMatchObject({ status: "cannot_delay", send_at: "tomorrow morning" });
    expect(String((summary.output as { reason: string }).reason)).toContain("tomorrow morning");
    expect(w.saves).toHaveLength(0);
    const refused = world(async () => ({ ok: false, problems: ["when.runAt: that moment is in the past"] }));
    const past = await refused.run({ send_at: "2020-01-01T00:00" });
    expect(past.summary.output).toMatchObject({ status: "cannot_delay", reason: "when.runAt: that moment is in the past" });
    expect(refused.sends).toHaveLength(0);
  });

  it("without send_at the step is skipped and the send runs", async () => {
    const w = world();
    const { summary } = await w.run({});
    expect(summary.output, summary.error ?? "").toMatchObject({ status: "sent", message_id: "m-1" });
    expect(w.saves).toHaveLength(0);
    expect(w.sends).toHaveLength(1);
  });
});
