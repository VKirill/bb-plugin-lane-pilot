/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "../i18n";
import { COLUMNS, conflictKeys, cronWords, groupByColumn, viewDays } from "../src/ui/schedule-model";
import type { RunView, ScheduleView } from "../src/schedule/views";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

// 2026-10-08 12:00 local, a Thursday.
const NOW = new Date(2026, 9, 8, 12, 0).getTime();
const at = (day: number, hour: number, minute = 0, month = 9) => new Date(2026, month, day, hour, minute).getTime();

const run = (id: string, scheduleId: string, status: RunView["status"], extra: Partial<RunView> = {}): RunView => ({
  id, scheduleId, scheduledAt: at(7, 9), trigger: "tick", status, reason: null, queuedAt: at(7, 9), startedAt: at(7, 9), finishedAt: at(7, 9, 1), durationMs: 60_000,
  refKind: null, refId: null, hostId: null, exitCode: null, output: null, error: null, truncated: false, ...extra,
});

function schedule(id: string, column: ScheduleView["column"], extra: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id, projectId: "proj_a", name: `Task ${id}`, description: "", task: { kind: "errand", task: `Check the leads of ${id}`, authorized: false, accounts: [] } as ScheduleView["task"],
    when: { type: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Madrid" }, missed: "run_once", missedLimit: 5, overlap: "skip", timeoutSec: 3600, maxFailures: 3,
    state: column === "paused" ? "paused" : "active", pauseReason: null, consecutiveFailures: 0, createdBy: "owner", createdAt: at(1, 9), updatedAt: at(7, 9),
    nextFires: [at(9, 9), at(10, 9)], machine: null, lastRun: null, active: [], column, ...extra,
  };
}

const fixtures = () => [
  schedule("s1", "scheduled", { lastRun: run("r1", "s1", "succeeded") }),
  schedule("s2", "running", { active: [run("r2", "s2", "running", { refKind: "thread", refId: "thr_errand", finishedAt: null })], lastRun: run("r2", "s2", "running") }),
  schedule("s3", "waiting", { active: [run("r3", "s3", "waiting", { finishedAt: null })] }),
  schedule("s4", "done", { when: { type: "once", runAt: at(6, 10) }, nextFires: [], state: "done", lastRun: run("r4", "s4", "succeeded") }),
  schedule("s5", "failed", { consecutiveFailures: 2, lastRun: run("r5", "s5", "failed", { error: "boom" }) }),
  schedule("s6", "paused", { pauseReason: "3 failures in a row", nextFires: [], task: { kind: "script", hostId: "mini", command: "echo hi\nsecond", cwd: "/tmp", env: [] } as ScheduleView["task"], machine: "Mac mini" }),
];

type Handlers = Record<string, (input: any) => unknown>;
async function mount(handlers: Handlers = {}, props: { projectId?: string | null; schedules?: ScheduleView[] } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  void app;
  const { ScheduleBoard } = await import("../src/ui/schedule-board");
  const projectId = props.projectId === undefined ? "proj_a" : props.projectId;
  const list = props.schedules ?? fixtures();
  return renderSlot({ component: () => <ScheduleBoard projectId={projectId} projects={[{ id: "proj_a", name: "Alpha" }, { id: "proj_b", name: "Beta" }]} locale="en" /> }, {}, {
    context: { projectId, threadId: null },
    rpc: {
      schedule_list: () => ({ schedules: list, hosts: [{ id: "mini", name: "Mac mini", connected: true }, { id: "mac", name: "MacBook", connected: false }], now: NOW }),
      schedule_runs: () => ({ runs: [], total: 0 }),
      schedule_calendar: () => ({ planned: [], past: [], truncated: [] }),
      schedule_preview: () => ({ ok: true, problems: [], warnings: [], conflicts: [], nextFires: [at(9, 9)], timeoutSec: 3600 }),
      workflow_list: () => ({ workflows: [{ id: "wf1", name: { en: "Lead digest", ru: "Сводка лидов" }, status: "published", internal: false }], problems: [], project: "ok" }),
      activation_context: () => ({ liveRun: null }),
      ...handlers,
    } as never,
  });
}
const calls = (slot: { rpcCalls: Array<{ method: string; input: unknown }> }, method: string) => slot.rpcCalls.filter((item) => item.method === method);

describe("schedule board", () => {
  it("puts every card in its column with counts, and says nothing is there for an empty one", async () => {
    const slot = await mount({}, { schedules: fixtures().filter((item) => item.id !== "s3") });
    await slot.findByTestId("sch-board");
    expect(COLUMNS).toEqual(["scheduled", "running", "waiting", "done", "failed", "paused"]);
    const titles = Object.fromEntries(COLUMNS.map((column) => [column, slot.getByTestId(`sch-column-${column}`).querySelector("h2")!.textContent]));
    expect(titles).toEqual({ scheduled: "Scheduled", running: "Running", waiting: "Waiting for you", done: "Done", failed: "Failed", paused: "Paused" });
    for (const [column, id] of [["scheduled", "s1"], ["running", "s2"], ["done", "s4"], ["failed", "s5"], ["paused", "s6"]] as const) {
      expect(slot.getByTestId(`sch-column-${column}`).contains(slot.getByTestId(`sch-card-${id}`))).toBe(true);
      expect(slot.getByTestId(`sch-count-${column}`).textContent).toBe("1");
    }
    expect(slot.getByTestId("sch-count-waiting").textContent).toBe("0");
    expect(slot.getByTestId("sch-column-waiting").textContent).toContain("Nothing here");
  });

  it("shows what the task does, when, the next run, the last result and the machine on a card", async () => {
    const slot = await mount();
    await slot.findByTestId("sch-card-s1");
    expect(slot.getByTestId("sch-kind-s1").textContent).toBe("Errand");
    expect(slot.getByTestId("sch-what-s1").textContent).toBe("Check the leads of s1");
    expect(slot.getByTestId("sch-when-s1").textContent).toBe("Every weekday at 9:00 · Europe/Madrid");
    expect(slot.getByTestId("sch-next-s1").textContent).toContain("Next:");
    expect(slot.getByTestId("sch-last-s1").textContent).toContain("Succeeded");
    expect(slot.getByTestId("sch-last-s5").textContent).toContain("Failed");
    expect(slot.getByTestId("sch-card-s5").textContent).toContain("2 failed in a row");
    expect(slot.getByTestId("sch-last-s2").textContent).toContain("Running");
    expect(slot.getByTestId("sch-kind-s6").textContent).toBe("Script");
    expect(slot.getByTestId("sch-what-s6").textContent).toBe("echo hi");
    expect(slot.getByTestId("sch-card-s6").textContent).toContain("Machine: Mac mini");
    expect(slot.getByTestId("sch-next-s6").textContent).toBe("Paused: 3 failures in a row");
    expect(slot.getByTestId("sch-when-s4").textContent).toMatch(/^Once, /);
    expect(slot.getByTestId("sch-last-s6").textContent).toBe("Has not run yet");
  });

  it("speaks Russian when the locale is Russian", async () => {
    setLocaleOverride("ru");
    const slot = await mount();
    await slot.findByTestId("sch-board");
    expect(slot.getByTestId("sch-column-waiting").querySelector("h2")!.textContent).toBe("Ждёт тебя");
    expect(slot.getByTestId("sch-column-paused").querySelector("h2")!.textContent).toBe("На паузе");
    expect(slot.getByTestId("sch-when-s1").textContent).toBe("По будням в 9:00 · Europe/Madrid");
    expect(slot.getByTestId("sch-run-now-s1").textContent).toBe("Запустить сейчас");
  });

  it("runs now, pauses, resumes and stops a live run", async () => {
    const slot = await mount({
      schedule_run_now: () => ({ ok: true, run: null, created: true }),
      schedule_pause: () => ({ schedule: null }),
      schedule_resume: () => ({ schedule: null }),
      schedule_cancel_run: () => ({ ok: true }),
    });
    await slot.findByTestId("sch-card-s1");
    fireEvent.click(slot.getByTestId("sch-run-now-s1"));
    await waitFor(() => expect(calls(slot, "schedule_run_now")).toEqual([{ method: "schedule_run_now", input: { id: "s1" } }]));
    await slot.findByTestId("sch-notice");
    fireEvent.click(slot.getByTestId("sch-pause-s1"));
    await waitFor(() => expect(calls(slot, "schedule_pause")).toHaveLength(1));
    expect(calls(slot, "schedule_pause")[0]!.input).toEqual({ id: "s1" });
    expect(slot.getByTestId("sch-pause-s6").textContent).toBe("Resume");
    fireEvent.click(slot.getByTestId("sch-pause-s6"));
    await waitFor(() => expect(calls(slot, "schedule_resume")).toEqual([{ method: "schedule_resume", input: { id: "s6" } }]));
    expect(slot.queryByTestId("sch-cancel-s1")).toBeNull();
    fireEvent.click(slot.getByTestId("sch-cancel-s2"));
    await waitFor(() => expect(calls(slot, "schedule_cancel_run")).toEqual([{ method: "schedule_cancel_run", input: { runId: "r2" } }]));
    // The running errand's thread opens from its card.
    fireEvent.click(slot.getByTestId("sch-open-s2"));
    expect(slot.navigateCalls.length).toBeGreaterThan(0);
  });

  it("shows the reason when a run is refused", async () => {
    const slot = await mount({ schedule_run_now: () => ({ ok: false, run: null, created: false, reason: "workflow_not_published" }) });
    await slot.findByTestId("sch-card-s1");
    fireEvent.click(slot.getByTestId("sch-run-now-s1"));
    expect((await slot.findByTestId("sch-error")).textContent).toContain("workflow_not_published");
  });

  it("shows the history: statuses, trigger, error, output, the errand's thread, and older runs on demand", async () => {
    const first = Array.from({ length: 20 }, (_, i) => run(`h${i}`, "s5", i === 0 ? "failed" : "succeeded", i === 0 ? { error: "exit 2", exitCode: 2, output: "line one\nline two", refKind: "thread", refId: "thr_x" } : { trigger: i === 1 ? "manual" : "tick" }));
    const slot = await mount({ schedule_runs: (input: { offset?: number }) => input.offset ? { runs: [run("older", "s5", "timed_out")], total: 21 } : { runs: first, total: 21 } });
    await slot.findByTestId("sch-card-s5");
    fireEvent.click(slot.getByTestId("sch-history-s5"));
    await slot.findByTestId("sch-history-list");
    expect(slot.getByTestId("sch-run-status-h0").textContent).toBe("Failed");
    expect(slot.getByTestId("sch-run-h0").textContent).toContain("exit code 2");
    expect(slot.getByTestId("sch-run-error-h0").textContent).toContain("exit 2");
    expect(slot.getByTestId("sch-run-output-h0").textContent).toBe("line one\nline two");
    expect(slot.getByTestId("sch-run-h1").textContent).toContain("by hand");
    expect(slot.getByTestId("sch-run-h2").textContent).toContain("by schedule");
    fireEvent.click(slot.getByTestId("sch-run-open-h0"));
    expect(slot.navigateCalls.length).toBeGreaterThan(0);
    fireEvent.click(slot.getByTestId("sch-history-more"));
    await slot.findByTestId("sch-run-older");
    expect(slot.getByTestId("sch-run-status-older").textContent).toBe("Timed out");
    expect(slot.queryByTestId("sch-history-more")).toBeNull();
    fireEvent.click(slot.getByTestId("sch-history-back"));
    await slot.findByTestId("sch-board");
  });

  it("stops a waiting run from the history", async () => {
    const slot = await mount({ schedule_runs: () => ({ runs: [run("w1", "s3", "waiting", { finishedAt: null })], total: 1 }), schedule_cancel_run: () => ({ ok: true }) });
    await slot.findByTestId("sch-card-s3");
    fireEvent.click(slot.getByTestId("sch-history-s3"));
    fireEvent.click(await slot.findByTestId("sch-run-cancel-w1"));
    await waitFor(() => expect(calls(slot, "schedule_cancel_run")[0]!.input).toEqual({ runId: "w1" }));
  });

  it("on the global page names the project of each card and lists every project", async () => {
    const slot = await mount({}, { projectId: null, schedules: [schedule("g1", "scheduled", { projectId: "proj_b" })] });
    await slot.findByTestId("sch-card-g1");
    expect(slot.getByTestId("sch-project-g1").textContent).toBe("Project: Beta");
    expect(calls(slot, "schedule_list")[0]!.input).toEqual({ next: 5 });
  });

  it("says so when there is nothing yet", async () => {
    const slot = await mount({}, { schedules: [] });
    expect((await slot.findByTestId("sch-empty")).textContent).toContain("No scheduled tasks yet");
  });
});

describe("schedule calendar", () => {
  const planned = [
    { scheduleId: "s1", at: at(9, 9) }, { scheduleId: "s1", at: at(12, 9) }, { scheduleId: "s1", at: at(12, 18) }, { scheduleId: "s1", at: at(20, 9) },
  ];
  const past = [run("p1", "s5", "failed", { startedAt: at(7, 9), scheduledAt: at(7, 9) }), run("p2", "s1", "skipped", { startedAt: at(7, 10) })];
  const calendarRpc = (extra: Handlers = {}) => ({ schedule_calendar: () => ({ planned, past, truncated: [] }), ...extra });
  const dayId = (day: number, month = 9) => `sch-cal-day-${new Date(2026, month, day).getTime()}`;

  it("lays a month out in whole weeks and counts planned and past runs per day", async () => {
    const slot = await mount(calendarRpc());
    fireEvent.click(await slot.findByTestId("sch-view-calendar"));
    await slot.findByTestId("sch-cal-grid");
    expect(slot.getByTestId("sch-cal-title").textContent!.toLowerCase()).toContain("october");
    const cells = slot.getByTestId("sch-cal-grid").children;
    expect(cells.length % 7).toBe(0);
    expect(cells.length).toBe(35);
    await waitFor(() => expect(slot.getByTestId(dayId(12)).getAttribute("data-count")).toBe("2"));
    expect(slot.getByTestId(dayId(9)).getAttribute("data-count")).toBe("1");
    // The skipped run is not shown; the failed one is.
    expect(slot.getByTestId(dayId(7)).getAttribute("data-count")).toBe("1");
    expect(slot.getByTestId(dayId(10)).getAttribute("data-count")).toBe("0");
    const range = calls(slot, "schedule_calendar")[0]!.input as { projectId: string; from: number; to: number };
    expect(range.projectId).toBe("proj_a");
    expect(range.from).toBe(new Date(2026, 8, 28).getTime());
    expect(range.to).toBe(new Date(2026, 10, 2).getTime() - 1);
  });

  it("opens a day, shows its events, and moves between months", async () => {
    const slot = await mount(calendarRpc());
    fireEvent.click(await slot.findByTestId("sch-view-calendar"));
    await waitFor(() => expect(slot.getByTestId(dayId(12)).getAttribute("data-count")).toBe("2"));
    fireEvent.click(slot.getByTestId(dayId(12)));
    const section = slot.getByTestId(`sch-cal-section-${new Date(2026, 9, 12).getTime()}`);
    expect(section.querySelectorAll("li").length).toBe(2);
    expect(section.textContent).toContain("Task s1");
    expect(section.querySelector("[data-kind=planned]")).toBeTruthy();
    fireEvent.click(slot.getByTestId(dayId(7)));
    expect(slot.getByTestId(`sch-cal-section-${new Date(2026, 9, 7).getTime()}`).querySelector("[data-kind=past]")!.textContent).toContain("Failed");
    fireEvent.click(slot.getByTestId("sch-cal-next"));
    await waitFor(() => expect(slot.getByTestId("sch-cal-title").textContent!.toLowerCase()).toContain("november"));
    fireEvent.click(slot.getByTestId("sch-cal-today"));
    await waitFor(() => expect(slot.getByTestId("sch-cal-title").textContent!.toLowerCase()).toContain("october"));
  });

  it("shows a week as seven day sections starting on Monday, and the next seven days from today", async () => {
    const slot = await mount(calendarRpc());
    fireEvent.click(await slot.findByTestId("sch-view-calendar"));
    fireEvent.click(await slot.findByTestId("sch-cal-view-week"));
    const week = await slot.findByTestId("sch-cal-days");
    expect(week.children.length).toBe(7);
    expect(week.children[0]!.getAttribute("data-testid")).toBe(`sch-cal-section-${new Date(2026, 9, 5).getTime()}`);
    const range = calls(slot, "schedule_calendar").at(-1)!.input as { from: number; to: number };
    expect(range.from).toBe(new Date(2026, 9, 5).getTime());
    expect(range.to).toBe(new Date(2026, 9, 12).getTime() - 1);
    fireEvent.click(slot.getByTestId("sch-cal-view-list"));
    await waitFor(() => expect(slot.getByTestId("sch-cal-days").children[0]!.getAttribute("data-testid")).toBe(`sch-cal-section-${new Date(2026, 9, 8).getTime()}`));
    expect(slot.getByTestId("sch-cal-days").children.length).toBe(7);
    expect(slot.queryByTestId("sch-cal-prev")).toBeNull();
    // Past days have no add button; today and later do.
    expect(slot.queryByTestId(`sch-cal-add-${new Date(2026, 9, 7).getTime()}`)).toBeNull();
    expect(slot.getByTestId(`sch-cal-add-${new Date(2026, 9, 9).getTime()}`)).toBeTruthy();
  });

  it("creates a one-time task from a day: the form opens on that day at 9:00 and saves a once schedule", async () => {
    const slot = await mount(calendarRpc({ schedule_upsert: (input: { definition: Record<string, unknown> }) => ({ ok: true, schedule: null, problems: [], warnings: [], conflicts: [], echo: input }) }));
    fireEvent.click(await slot.findByTestId("sch-view-calendar"));
    await waitFor(() => expect(slot.getByTestId(dayId(12)).getAttribute("data-count")).toBe("2"));
    fireEvent.click(slot.getByTestId(dayId(14)));
    fireEvent.click(slot.getByTestId(`sch-cal-add-${new Date(2026, 9, 14).getTime()}`));
    await slot.findByTestId("schedule-form");
    expect((slot.getByTestId("sch-runat") as HTMLInputElement).value).toBe("2026-10-14T09:00");
    fireEvent.change(slot.getByTestId("sch-name"), { target: { value: "Call back" } });
    fireEvent.change(slot.getByTestId("sch-errand"), { target: { value: "Call the client back and report." } });
    await waitFor(() => expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByTestId("sch-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    const definition = (calls(slot, "schedule_upsert")[0]!.input as { definition: Record<string, any> }).definition;
    expect(definition).toMatchObject({ projectId: "proj_a", name: "Call back", when: { type: "once", runAt: at(14, 9) }, task: { kind: "errand", task: "Call the client back and report.", authorized: false } });
    await slot.findByTestId("sch-board");
  });

  it("marks two tasks on one machine within ten minutes, and opens a task's history from an event", async () => {
    const two = [schedule("m1", "scheduled", { machine: "Mac mini" }), schedule("m2", "scheduled", { machine: "Mac mini" })];
    const slot = await mount({ schedule_calendar: () => ({ planned: [{ scheduleId: "m1", at: at(9, 9) }, { scheduleId: "m2", at: at(9, 9, 5) }, { scheduleId: "m1", at: at(10, 9) }], past: [], truncated: [] }) }, { schedules: two });
    fireEvent.click(await slot.findByTestId("sch-view-calendar"));
    await waitFor(() => expect(slot.getByTestId(dayId(9)).getAttribute("data-count")).toBe("2"));
    fireEvent.click(slot.getByTestId(dayId(9)));
    const marked = slot.getByTestId(`sch-cal-section-${new Date(2026, 9, 9).getTime()}`).querySelectorAll("[data-conflict='1']");
    expect(marked.length).toBe(2);
    expect(slot.getByTestId(`sch-cal-conflict-p:m1:${at(9, 9)}`).textContent).toBe("Two tasks on Mac mini within 10 minutes");
    fireEvent.click(slot.getByTestId(dayId(10)));
    expect(slot.getByTestId(`sch-cal-section-${new Date(2026, 9, 10).getTime()}`).querySelector("[data-conflict='1']")).toBeNull();
    fireEvent.click(slot.getByTestId(dayId(9)));
    fireEvent.click(slot.getByTestId(`sch-cal-event-p:m1:${at(9, 9)}`));
    await slot.findByTestId("schedule-history");
    fireEvent.click(slot.getByTestId("sch-history-back"));
    await slot.findByTestId("schedule-calendar");
  });
});

describe("create forms", () => {
  it("creates a script task from the form with a live check of the definition", async () => {
    const preview = vi.fn((input: { definition: Record<string, any> }) => ({ ok: true, problems: input.definition.task.cwd === "/tmp" ? [] : ["cwd must start with /"], warnings: ["Mac mini is busy at 9:00"], conflicts: [], nextFires: [at(9, 9), at(12, 9)], timeoutSec: 600 }));
    const slot = await mount({ schedule_preview: preview, schedule_upsert: () => ({ ok: true, schedule: null, problems: [], warnings: [], conflicts: [] }) });
    fireEvent.click(await slot.findByTestId("sch-create-form"));
    await slot.findByTestId("schedule-form");
    expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByTestId("sch-kind-script"));
    fireEvent.change(slot.getByTestId("sch-name"), { target: { value: "Sync keys" } });
    fireEvent.change(slot.getByTestId("sch-command"), { target: { value: "bash sync.sh" } });
    fireEvent.click(slot.getByTestId("sch-preset-daily"));
    expect((slot.getByTestId("sch-cron") as HTMLInputElement).value).toBe("0 9 * * *");
    await slot.findByTestId("sch-next-runs");
    expect(slot.getByTestId("sch-warnings").textContent).toContain("Mac mini is busy at 9:00");
    await waitFor(() => expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByTestId("sch-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    const definition = (calls(slot, "schedule_upsert")[0]!.input as { definition: Record<string, any> }).definition;
    expect(definition).toMatchObject({ projectId: "proj_a", name: "Sync keys", task: { kind: "script", hostId: "mini", command: "bash sync.sh", cwd: "/tmp" }, when: { type: "cron", cron: "0 9 * * *" } });
    expect(definition.id).toBeUndefined();
    await slot.findByTestId("sch-board");
  });

  it("does not save while the check reports a problem, and shows what the server refused", async () => {
    const slot = await mount({ schedule_preview: () => ({ ok: false, problems: ["cron has 4 fields"], warnings: [], conflicts: [], nextFires: [], timeoutSec: null }) });
    fireEvent.click(await slot.findByTestId("sch-create-form"));
    fireEvent.change(await slot.findByTestId("sch-name"), { target: { value: "Bad" } });
    fireEvent.change(slot.getByTestId("sch-errand"), { target: { value: "Do something useful." } });
    expect((await slot.findByTestId("sch-problems")).textContent).toContain("cron has 4 fields");
    expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits a task in place: same id and the policies it had, and deletes it", async () => {
    const slot = await mount({ schedule_upsert: () => ({ ok: false, schedule: null, problems: ["name taken"], warnings: [], conflicts: [] }), schedule_delete: () => ({ ok: true }) });
    await slot.findByTestId("sch-card-s1");
    fireEvent.click(slot.getByTestId("sch-edit-s1"));
    expect((await slot.findByTestId("sch-name") as HTMLInputElement).value).toBe("Task s1");
    expect((slot.getByTestId("sch-cron") as HTMLInputElement).value).toBe("0 9 * * 1-5");
    expect((slot.getByTestId("sch-kind-script") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByTestId("sch-name"), { target: { value: "Renamed" } });
    await waitFor(() => expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByTestId("sch-save"));
    expect((await slot.findByTestId("sch-save-error")).textContent).toContain("name taken");
    expect(calls(slot, "schedule_upsert")[0]!.input).toMatchObject({ definition: { id: "s1", name: "Renamed", missed: "run_once", overlap: "skip", timeoutSec: 3600, maxFailures: 3 } });
    fireEvent.click(slot.getByTestId("sch-delete"));
    await waitFor(() => expect(calls(slot, "schedule_delete")).toEqual([{ method: "schedule_delete", input: { id: "s1" } }]));
    await slot.findByTestId("sch-board");
  });

  it("builds a chain task from the project's published chains", async () => {
    const slot = await mount({ schedule_upsert: () => ({ ok: true, schedule: null, problems: [], warnings: [], conflicts: [] }) });
    fireEvent.click(await slot.findByTestId("sch-create-form"));
    fireEvent.click(await slot.findByTestId("sch-kind-workflow"));
    await slot.findByTestId("sch-workflow");
    expect(calls(slot, "workflow_list")[0]!.input).toEqual({ projectId: "proj_a" });
    fireEvent.change(slot.getByTestId("sch-name"), { target: { value: "Digest" } });
    fireEvent.change(slot.getByTestId("sch-inputs"), { target: { value: "{not json" } });
    expect((await slot.findByTestId("sch-problems")).textContent).toContain("not valid JSON");
    fireEvent.change(slot.getByTestId("sch-inputs"), { target: { value: "{\"topic\":\"leads\"}" } });
    await waitFor(() => expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByTestId("sch-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    expect((calls(slot, "schedule_upsert")[0]!.input as { definition: Record<string, any> }).definition.task).toEqual({ kind: "workflow", workflowId: "wf1", inputs: { topic: "leads" } });
  });

  it("on the global page asks for the project", async () => {
    const slot = await mount({}, { projectId: null, schedules: [] });
    fireEvent.click(await slot.findByTestId("sch-create-form"));
    expect(await slot.findByTestId("sch-project")).toBeTruthy();
  });

  it("opens the project manager's chat to create by text, or a new chat when none is open", async () => {
    const withChat = await mount({ activation_context: () => ({ liveRun: { threadId: "thr_pm", runId: "run_1" } }) });
    fireEvent.click(await withChat.findByTestId("sch-create-text"));
    await withChat.findByTestId("schedule-text");
    expect((await withChat.findByTestId("sch-text-chat"))).toBeTruthy();
    expect(calls(withChat, "activation_context")[0]!.input).toEqual({ projectId: "proj_a", threadId: null });
    fireEvent.click(withChat.getByTestId("sch-text-open-thread"));
    expect(withChat.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_pm" });
    fireEvent.click(withChat.getByTestId("sch-text-close"));
    await withChat.findByTestId("sch-board");
    cleanup();

    const none = await mount();
    fireEvent.click(await none.findByTestId("sch-create-text"));
    expect((await none.findByTestId("sch-text-nochat")).textContent).toContain("not open");
    fireEvent.click(none.getByTestId("sch-text-compose"));
    expect(none.navigateCalls).toContainEqual({ method: "toCompose", options: { initialPrompt: "Create a scheduled task: ", focusPrompt: true } });
  });
});

describe("schedule model", () => {
  it("sorts scheduled cards by next run and the others by latest change", () => {
    const groups = groupByColumn([schedule("late", "scheduled", { nextFires: [at(20, 9)] }), schedule("soon", "scheduled", { nextFires: [at(9, 9)] }), schedule("old", "failed", { updatedAt: 1 }), schedule("new", "failed", { updatedAt: 9 })]);
    expect(groups.scheduled.map((s) => s.id)).toEqual(["soon", "late"]);
    expect(groups.failed.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("reads the cron shapes people say, and leaves the rest as they are", () => {
    expect(cronWords("30 8 * * *")).toMatchObject({ kind: "daily", time: "8:30" });
    expect(cronWords("0 9 * * 1-5")).toMatchObject({ kind: "weekdays", time: "9:00" });
    expect(cronWords("15 * * * *")).toMatchObject({ kind: "hourly", minute: "15" });
    expect(cronWords("0 9 1 * *")).toMatchObject({ kind: "monthly", day: "1" });
    expect(cronWords("*/5 * * * *")).toBeNull();
    expect(cronWords("0 9 * * 1,3")).toBeNull();
  });

  it("lays months out in whole weeks (4, 5 or 6) and a week that crosses the DST change", () => {
    expect(viewDays("month", at(1, 12, 0, 2), NOW).length).toBe(42);
    expect(viewDays("month", at(1, 12, 0, 5), NOW).length).toBe(35);
    expect(new Date(2027, 1, 1).getDay()).toBe(1);
    expect(viewDays("month", new Date(2027, 1, 10).getTime(), NOW).length).toBe(28);
    const week = viewDays("week", at(25, 12), NOW);
    expect(week.map((day) => new Date(day).getHours())).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(conflictKeys([{ scheduleId: "a", at: 0 }, { scheduleId: "b", at: 11 * 60_000 }], [{ id: "a", machine: "x" }, { id: "b", machine: "x" }]).size).toBe(0);
  });
});
