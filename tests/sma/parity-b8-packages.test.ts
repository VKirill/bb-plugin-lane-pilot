/** @vitest-environment jsdom */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import { createHostJobs, isHostJobKind } from "@lane-pilot/host-calls";
import { registeredTools } from "../../src/rooms/platform/server";
import { createBacklog } from "../../src/rooms/backlog/server/scanner";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { upsertAttemptChange } from "../../src/rooms/rollback/store";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";
import { tokenDailyByModel } from "../../src/rooms/usage/server";
import { calibrationBadge, calibrate, calibrationLine, dependenciesAddedInDiff, scoreForecast, stampForecastModel } from "../../src/rooms/forecast/logic";
import { calibrationPassport, forecastReport } from "../../src/rooms/forecast/server/report";
import { passport } from "../../src/rooms/tools/server/receipts";
import { recordStage } from "../../src/rooms/runs/server";
import { SETTING_BACKLOG_SCAN_MINUTES } from "@lane-pilot/settings-catalog";
import { setLocaleOverride, t } from "@lane-pilot/i18n";
import { ComposerBoundary } from "../../src/rooms/native-agent/ui/composer-boundary";
import { cleanup, waitFor } from "@testing-library/react";

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };
const pmMeta = (harness: { sdk: { stub: (name: string, fn: () => Promise<unknown>) => void } }, runId = "run1") => harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: runId }));

type JobCall = { method: string; input: Record<string, unknown> };
/** A host that answers runSandboxedCommand jobs: jobStart takes the job, jobStatus says running, jobCancel ends it. */
function jobHost(over: { finish?: Record<string, unknown>; calls?: JobCall[] }) {
  const calls = over.calls ?? [];
  const cancelled = new Set<string>();
  let seq = 0;
  const kv = { get: async () => undefined, set: async () => undefined, delete: async () => undefined };
  const raw = async (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input });
    if (method === "jobStart") return { jobId: `job_${++seq}` };
    if (method === "jobStatus") return cancelled.has(String(input.jobId)) ? { state: "cancelled", error: "cancelled", progress: { updatedAt: Date.now() } } : { state: "running", error: null, progress: { updatedAt: Date.now() } };
    if (method === "jobCancel") { cancelled.add(String(input.jobId)); return { ok: true }; }
    return over.finish ?? { exitCode: 0, stdout: "ok", stderr: "" };
  };
  const jobs = createHostJobs({ call: raw as never, kv, disposed: () => false, sleep: () => new Promise<void>((wake) => setTimeout(wake, 1)) });
  const host = { call: async (method: string, input: unknown, options: Record<string, unknown> = {}) =>
    isHostJobKind(method) && options.job ? jobs.run(method as never, input, options as never, () => raw(method, input as Record<string, unknown>), options.jobKey as string | undefined) : raw(method, input as Record<string, unknown>) };
  return { host, calls };
}

const untilEnded = async (check: { execute: (input: unknown, ctx: never) => unknown }, ctx: never, checkId: string) => {
  for (let i = 0; i < 200; i++) {
    const receipt = JSON.parse(String(await check.execute({ action: "status", checkId }, ctx))) as { state: string };
    if (receipt.state !== "running") return receipt as never;
    await new Promise((wake) => setTimeout(wake, 10));
  }
  throw new Error(`check ${checkId} never ended`);
};

describe("checks from the conversation can be stopped", () => {
  it("[sma:m_ck_stop] a running quick check returns its checkId at once; stop cancels the host job and the receipt names the stopped command", async () => {
    const { bb, db, harness } = open();
    pmMeta(harness);
    const calls: JobCall[] = [];
    const { host } = jobHost({ calls });
    createRun(db, "run1", "proj", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host1");
    registerConversationTools({ db, bb, host, log: () => undefined } as never, { spendByModel: (projectId: string, day: string) => tokenDailyByModel(db, projectId, day) });
    const check = registeredTools(bb.agents).get("lane_pilot_check")!;
    const ctx = { threadId: "thr_pm", projectId: "proj", signal: new AbortController().signal };
    const started = JSON.parse(String(await check.execute({
      action: "run", request: "run tests", commands: [{ command: "npm test --watch", cwd: ".", timeoutSec: 300, expectExit: 0 }],
    }, ctx)));
    // The answer is the check's id while its command still runs — the run no longer holds the turn.
    expect(started).toMatchObject({ recipe: "quick", state: "running" });
    expect(started.checkId).toMatch(/^chk_/);
    for (let i = 0; i < 200 && !calls.some((row) => row.method === "jobStart"); i++) await new Promise((wake) => setTimeout(wake, 5));
    const stopped = JSON.parse(String(await check.execute({ action: "stop", checkId: started.checkId }, ctx)));
    expect(stopped.checkId).toBe(started.checkId);
    const receipt = await untilEnded(check as never, ctx as never, started.checkId) as { state: string; stoppedCommand: string | null };
    expect(receipt.state).toBe("stopped");
    expect(receipt.stoppedCommand).toBe("npm test --watch");
    // The stop reached the host: the command's whole process tree was cancelled, not just the poll.
    expect(calls.some((row) => row.method === "jobCancel")).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("[sma:m_cd_stop] a check of a PM thread that went idle ends as stopped_by_turn_stop; another thread's check keeps running", async () => {
    const { bb: real, db, harness } = open();
    pmMeta(harness);
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const bb = Object.assign(Object.create(real), { pluginId: "lane-pilot", events: { on: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); } } });
    const calls: JobCall[] = [];
    const { host } = jobHost({ calls });
    createRun(db, "run1", "proj", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host1");
    registerConversationTools({ db, bb, host, log: () => undefined } as never, { spendByModel: (projectId: string, day: string) => tokenDailyByModel(db, projectId, day) });
    const check = registeredTools(bb.agents).get("lane_pilot_check")!;
    const ctxA = { threadId: "thr_a", projectId: "proj", signal: new AbortController().signal };
    const ctxB = { threadId: "thr_b", projectId: "proj", signal: new AbortController().signal };
    const a = JSON.parse(String(await check.execute({ action: "run", request: "check a", commands: [{ command: "tail -f a" }] }, ctxA)));
    const b = JSON.parse(String(await check.execute({ action: "run", request: "check b", commands: [{ command: "tail -f b" }] }, ctxB)));
    for (let i = 0; i < 200 && calls.filter((row) => row.method === "jobStart").length < 2; i++) await new Promise((wake) => setTimeout(wake, 5));
    const cancelsBefore = calls.filter((row) => row.method === "jobCancel").length;
    await handlers.get("thread.idle")?.({ thread: { id: "thr_a" } });
    const receipt = await untilEnded(check as never, ctxA as never, a.checkId) as { state: string; stoppedCommand: string | null };
    expect(receipt.state).toBe("stopped_by_turn_stop");
    expect(receipt.stoppedCommand).toBe("tail -f a");
    expect(calls.filter((row) => row.method === "jobCancel").length).toBeGreaterThan(cancelsBefore);
    // The other thread's check still runs: a stop reaches only the turn that was stopped.
    const alive = JSON.parse(String(await check.execute({ action: "status", checkId: b.checkId }, ctxB)));
    expect(alive.state).toBe("running");
    expect(alive.running).toBe(true);
    await handlers.get("thread.idle")?.({ thread: { id: "thr_b" } });
    await untilEnded(check as never, ctxB as never, b.checkId);
    await harness.lifecycle.dispose();
  });
});

describe("the composer boundary line", () => {
  it("[sma:m_ce_boundary] the line shows under the input of a PM chat and nowhere else", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    const row = app.composerCustomizations.find((item) => item.id === "lane-pilot-boundary");
    // Thread scope only: a new chat has no PM to hold the boundary.
    expect(row?.scopes).toEqual(["thread"]);
    const banner = row?.banners?.[0];
    if (!banner) throw new Error("missing boundary banner");
    const mount = (role: string | null, locale: "en" | "ru") => {
      setLocaleOverride(locale);
      return renderSlot({ component: banner.component }, {}, {
        context: { projectId: null, threadId: "thr_pm" },
        composer: { scope: { kind: "thread", threadId: "thr_pm" }, text: "" },
        rpc: { native_thread: () => ({ token: "t", agentId: "claude", agentType: "claude-code", projectId: "p", description: "pm", role }) },
      });
    };
    const en = mount("pm", "en");
    await waitFor(() => expect(en.container.textContent).toContain(t("composerBoundary")));
    expect(t("composerBoundary")).toBe("Work in this chat starts only on your word; accepting each result is yours too.");
    cleanup();
    const ruMount = mount("pm", "ru");
    await waitFor(() => expect(ruMount.container.textContent).toContain("по вашему слову"));
    cleanup();
    for (const role of ["writer", null]) {
      const other = mount(role, "en");
      await new Promise((wake) => setTimeout(wake, 20));
      expect(other.container.textContent).toBe("");
      cleanup();
    }
    setLocaleOverride(null);
  });
});

describe("the backlog scan cadence", () => {
  it("[sma:m_in_cadence] a project scans only once its interval passed since the last scan; the scan writes that time", async () => {
    const { bb, db, harness } = open();
    const now = Date.now();
    createRun(db, "run1", "projA", "cli");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run1'").run();
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm" }));
    const api = createBacklog({ db, bb, host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, isDisposed: () => false, log: () => undefined } as never).backlog;
    saveProjectSetting(db, "projA", SETTING_BACKLOG_SCAN_MINUTES, 120);
    // The last scan was 60 minutes ago under a 120-minute interval: the project is left alone.
    await bb.storage.kv.set("backlog:last-scan:projA", now - 60 * 60_000 as never);
    const skipped = (await api.scan(now))[0]!;
    expect(skipped).toMatchObject({ projectId: "projA", scanned: false, lastScanAt: now - 60 * 60_000, offered: null });
    expect(await bb.storage.kv.get("backlog:last-scan:projA")).toBe(now - 60 * 60_000);
    // 121 minutes ago the interval has passed: the project scans and now travels into the kv.
    await bb.storage.kv.set("backlog:last-scan:projA", now - 121 * 60_000 as never);
    const scanned = (await api.scan(now))[0]!;
    expect(scanned).toMatchObject({ projectId: "projA", scanned: true, lastScanAt: now });
    expect(await bb.storage.kv.get("backlog:last-scan:projA")).toBe(now);
    // Without the setting the default hour rules.
    saveProjectSetting(db, "projA", SETTING_BACKLOG_SCAN_MINUTES, 60);
    const again = (await api.scan(now + 61 * 60_000))[0]!;
    expect(again.scanned).toBe(true);
    await harness.lifecycle.dispose();
  });
});

describe("the forecast keeps its model and its declared footprint", () => {
  const contract = (id: string, model: string, files = 2) => ({
    schema_version: 2, id, title: id, risk: "low", lane: "w", project_cwd: "/w", read_first: [], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["x"], owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "o",
    acceptance: ["a"], verify: "none", verification: [], forecast: { files, checks_pass_first_try: true, model },
  });
  const seedScored = (db: ReturnType<typeof openDatabase>, id: string, model: string, files = 2) => {
    createTask(db, { id, runId: "run1", kind: "bb", contract: contract(id, model, files) });
    createAttempt(db, { id: `a_${id}`, runId: "run1", taskId: id });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', attempt_no=1 WHERE id=?").run(`a_${id}`);
    upsertAttemptChange(db, { attemptId: `a_${id}`, runId: "run1", taskId: id }, { outcome: "merged", changed: [{ path: "src/a.ts", status: "modified" }, { path: "src/b.ts", status: "modified" }] });
  };

  it("[sma:k_lib_modelver] a model reads only its own priors; dispatch stamps the run's pm model over a PM-sent one", async () => {
    const { bb, db, harness } = open();
    createRun(db, "run1", "projA");
    for (let i = 0; i < 5; i++) seedScored(db, `ta${i}`, "codex/gpt-a");
    seedScored(db, "tb0", "codex/gpt-b");
    const report = forecastReport(db, { projectId: "projA" });
    expect(report.scored).toHaveLength(6);
    // Old priors are about model A: for B the headline hides, for A it is a line over 5 tasks.
    const forB = calibrate(report.scored, "codex/gpt-b");
    expect(calibrationLine(forB.overall ?? undefined)).toBeNull();
    const forA = calibrate(report.scored, "codex/gpt-a");
    expect(forA.overall?.tasks).toBe(5);
    expect(calibrationLine(forA.overall ?? undefined)).toContain("5 tasks");
    // The full report still lists every model.
    expect(report.calibration.overall?.tasks).toBe(6);
    // The stamp: whatever the PM sent, the run's own model is stored.
    const stamped = stampForecastModel(contract("t1", "x/y") as never, "claude/opus");
    expect((stamped as { forecast?: { model?: string } }).forecast?.model).toBe("claude/opus");
    await harness.lifecycle.dispose();
  });

  it("[sma:k_lib_footprint] files, lines and dependencies of the plan are checked against the merge's facts", () => {
    const score = scoreForecast(
      { files: 2, lines: 40, dependencies: ["zod"], checks_pass_first_try: true } as never,
      { files: 3, firstTry: true, tokens: null, minutes: null, lines: 90, dependencies: ["zod", "lodash"], changedPaths: ["a.ts", "b.ts", "c.ts"] },
      ["a.ts", "b.ts"],
    );
    expect(score.files.error).toBe(1);
    expect(score.lines).toEqual({ forecast: 40, fact: 90, error: 50 });
    expect(score.dependencies).toEqual({ undeclared: ["lodash"], notAdded: [] });
    expect(score.paths).toEqual({ unplanned: ["c.ts"], untouched: [] });
    // The diff parser reads added packages only inside dependency manifests.
    const diff = [
      "+++ b/package.json", '+    "lodash": "^4.17.21",', "+  \"private\": true,",
      "+++ b/requirements.txt", "+requests==2.31.0",
      "+++ b/pyproject.toml", '+    "aiohttp>=3",',
      "+++ b/src/x.ts", '+import lodash from "lodash";',
    ].join("\n");
    expect(dependenciesAddedInDiff(diff).sort()).toEqual(["aiohttp", "lodash", "requests"]);
  });

  it("[sma:k_v_passport] the passport shows the current model's badge and resets when the model changes", async () => {
    const { bb, db, harness } = open();
    createRun(db, "run1", "projA");
    for (const [key, value] of [["hostId", "h"], ["pmWorkspacePath", "/p"], ["writerWorkspacePath", "/w"], ["pmProviderId", "codex"], ["pmModel", "gpt-a"], ["writerProviderId", "codex"], ["writerModel", "gpt-w"]] as const)
      saveProjectSetting(db, "projA", key, value);
    // Four forecasts by model A, all within a file, all first-try right; one by model B, the current one.
    for (let i = 0; i < 4; i++) seedScored(db, `pa${i}`, "codex/gpt-a", 2);
    seedScored(db, "pb0", "codex/gpt-b", 2);
    const withB = () => { saveProjectSetting(db, "projA", "pmModel", "gpt-b"); };
    withB();
    const b = calibrationPassport(db, "projA");
    expect(b).toMatchObject({ model: "codex/gpt-b", tasks: 1, badge: "unrated" });
    saveProjectSetting(db, "projA", "pmModel", "gpt-a");
    expect(calibrationPassport(db, "projA").badge).toBe("calibrated");
    // A fifth A forecast ten files off flips the badge.
    createTask(db, { id: "pa4", runId: "run1", kind: "bb", contract: contract("pa4", "codex/gpt-a", 15) });
    createAttempt(db, { id: "a_pa4", runId: "run1", taskId: "pa4" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', attempt_no=2 WHERE id='a_pa4'").run();
    upsertAttemptChange(db, { attemptId: "a_pa4", runId: "run1", taskId: "pa4" }, { outcome: "merged", changed: [{ path: "src/c.ts", status: "added" }] });
    expect(calibrationPassport(db, "projA").badge).toBe("miscalibrated");
    // An attempt's passport names the badge of the model that wrote its forecast.
    recordStage(db, { runId: "run1", taskId: "pb0", stageId: "writer-agent", state: "passed", input: "{}", result: { ok: true } });
    const attemptPassport = passport(db, "a_pb0")!;
    expect(attemptPassport.calibration).toEqual({ model: "codex/gpt-b", badge: "unrated" });
    await harness.lifecycle.dispose();
  });
});
