// Region 5 · Daemon life, batch b — the observations behind the proofs of the map nodes n472–n502 (docs/sma-evidence.md). Each function runs the REAL code of this
// checkout on a scratch database, a fake host or stand-in tools and returns plain data. The test file tests/sma/four-proofs-r05-b.test.ts asserts these values;
// the drill scene sma_r05_b.py reads the same values (through sma_r05_b_probe.ts, vite-node) and compares them with the node card's result. No model, no hub, no network.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WRITER_EFFORT_CHOICES_BY_PROVIDER } from "@lane-pilot/settings-catalog";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { phaseWorld, item, dep } from "./r16-world";
import { planSignature } from "../../src/rooms/phase/logic";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { mountPermits } from "../../src/rooms/writer/server/permits";
import { createSecrets } from "../../src/rooms/secrets/server/secrets";
import { mountOutbound } from "../../src/rooms/relay/server/outbound";
import { ackDigest, planDigest, savePushConfig } from "../../src/rooms/owner-waiting/push";
import { postOwnerItem } from "../../src/rooms/owner-waiting";
import { CURL_STUB, SLEEP_STUB, SS_STUB, SYSTEMCTL_STUB, cleanupWatchdog, functions, holder, read, run as watchdog, stub, tmp, until } from "../helpers/hub-watchdog";
import { abortable } from "../../src/rooms/platform/server/schedules";
import { createCore } from "../../src/rooms/core/server/core";
import { unknownReasons } from "../../src/rooms/runs/unknown-codes";
import { validateSettingsObject } from "../../src/rooms/settings";
import { casUpsertSetting } from "../../src/rooms/storage/settings-store";
import { createAttempt, createRun, createTask, loadProjectSettings, openDatabase, getRun, saveProjectSetting, transitionAttempt } from "../../src/rooms/plugin-db";
import { ROLE_TABLE, roleDefaultModel, roleModelOption } from "../../packages/models/src/role-models";
import { capOf, moneyCapFrom, moneyHold } from "../../src/rooms/money";
import { buildRunPolicy, turnCeilingOf } from "../../src/rooms/tasks/run-policy";
import { turnCeilingOfRun } from "../../src/rooms/writer/server/writer-silence";

const scratch = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

export const observeB = {
  /** n472: a stop frees the slot at once; the work it abandons keeps running and finishes by itself. */
  async m_no_wait_stop() {
    const controller = new AbortController();
    let finished = false;
    const work = new Promise<string>((resolve) => setTimeout(() => { finished = true; resolve("late"); }, 150));
    const racing = abortable(controller.signal, work).then(() => "resolved", (cause: Error) => cause.message);
    controller.abort(new Error("time limit 60000 ms"));
    const settled = await racing;
    const finishedWhenFreed = finished;
    const result = await work;
    const early = new AbortController();
    early.abort("stopped by a reload");
    const never = new Promise<string>(() => undefined);
    const alreadyAborted = await abortable(early.signal, never).then(() => "resolved", (cause: Error) => cause.message);
    return { settled, finishedWhenFreed, workResult: result, workFinished: finished, alreadyAborted };
  },

  /** n473: the core's one log door writes one line, at warn, into the process output. */
  m_dj_journal() {
    const { bb, harness, db } = scratch();
    const core = createCore(bb, db);
    core.log("tick: sweep ran, door: version asked");
    return { entries: harness.logEntries.filter((entry) => entry.message.includes("tick: sweep ran")).map((entry) => `${entry.level}: ${entry.message}`) };
  },

  /** n474: reasons no class names, grouped by their text without digits, counted, newest time kept, most frequent first. */
  m_unknown_codes() {
    return unknownReasons([
      { reason: "verification failed: npm test", at: 1 },
      { reason: "strange fault at slot 12", at: 100 },
      { reason: "strange fault at slot 99", at: 300 },
      { reason: "odd one", at: 200 },
      { reason: "  ", at: 5 },
      { reason: null, at: 6 },
      { reason: "provider quota exhausted", at: 7 },
    ]);
  },

  /** n476: a whole settings object is judged key by key; a writer pair that cannot work is named too. */
  m_cfg_load() {
    const [provider, efforts] = Object.entries(WRITER_EFFORT_CHOICES_BY_PROVIDER)[0]!;
    const bad = ["low", "medium", "high", "xhigh", "max", "nonsense"].find((effort) => !efforts.includes(effort))!;
    const summarize = (errors: ReturnType<typeof validateSettingsObject>) => errors.map((error) => `${error.code}:${error.key}`);
    return {
      provider, bad, good: efforts[0],
      clean: summarize(validateSettingsObject({ "run.max_tokens": 5, "writer.provider": provider, "writer.reasoning_effort": efforts[0] })),
      broken: summarize(validateSettingsObject({ "run.max_tokens": 0, "writer.provider": provider, "writer.reasoning_effort": bad })),
    };
  },

  /** n477: the settings live as rows of the hub database, per project; a fresh read of the table sees what was saved (there is no settings file). */
  m_cfg_path() {
    const { db } = scratch();
    const saved = casUpsertSetting(db, { projectId: "proj", key: "run.max_tokens", value: 40, expectedVersion: 0 });
    const row = db.prepare("SELECT key, value, version FROM lane_pilot_project_settings WHERE project_id=?").all("proj");
    return { saved, row, loaded: loadProjectSettings(db, "proj") };
  },

  /** n482: each writer saves only its own key; a stale copy of a key is refused with the stored value, so a hand edit is never erased. */
  m_cfg_write() {
    const { db } = scratch();
    const a = casUpsertSetting(db, { projectId: "proj", key: "run.max_tokens", value: 40, expectedVersion: 0 });
    const b = casUpsertSetting(db, { projectId: "proj", key: "run.max_turns", value: 90, expectedVersion: 0 });
    const hand = casUpsertSetting(db, { projectId: "proj", key: "run.max_tokens", value: 55, expectedVersion: 1 });
    const stale = casUpsertSetting(db, { projectId: "proj", key: "run.max_tokens", value: 40, expectedVersion: 1 });
    return { a, b, hand, stale, stored: loadProjectSettings(db, "proj") };
  },

  /** n478: with no setting a role gets its table default: a model, an effort, source «default». */
  m_cfg_default() {
    const rows = ROLE_TABLE.map((row) => {
      const pick = roleDefaultModel(row.id);
      return { id: row.id, ok: pick.model === roleModelOption(row.default.model)!.id && pick.effort === row.default.effort && pick.source === "default" && pick.sourceKey === null && pick.providerId.length > 0, pick: `${pick.providerId}/${pick.model}/${pick.effort}` };
    });
    const pick = (id: string) => rows.find((row) => row.id === id)?.pick;
    return { roles: rows.length, allDefault: rows.every((row) => row.ok), analyst: pick("analyst"), copyLead: pick("copy-lead"), pmReader: pick("pm-reader"), auditor: pick("auditor") };
  },

  /** n481: a paid lane has no money while the cap is unset; a subscription lane never waits for money. */
  m_cfg_budget0() {
    const cap = moneyCapFrom({});
    return {
      cap, paid: moneyHold("openlux", 0, cap), subscription: moneyHold("claude-code", 0, cap),
      lifted: [moneyHold("openlux", 10_000, moneyCapFrom({ "money.cap_unset_zero": "off" })), moneyHold("openlux", 10_000, capOf("unlimited"))],
    };
  },

  /** n484: the turn ceiling is frozen into the run when it is created; a later setting change touches only the next run. */
  m_restart_scoped() {
    const { db } = scratch();
    createRun(db, "first", "proj", "bb", null, "none", buildRunPolicy({ "writer.max_turns": 5 }));
    saveProjectSetting(db, "proj", "writer.max_turns", 100);
    createRun(db, "second", "proj", "bb", null, "none", buildRunPolicy({ "writer.max_turns": 100 }));
    createRun(db, "old", "proj", "bb", null, "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } });
    return { first: turnCeilingOfRun(getRun(db, "first")), second: turnCeilingOfRun(getRun(db, "second")), old: turnCeilingOfRun(getRun(db, "old")) ?? null, stored: loadProjectSettings(db, "proj")["writer.max_turns"] };
  },

  /** n486: without a key the named default applies; 0 or off is none; a number 1-500 as given; anything else is refused. */
  m_cfg_max_turns() {
    return {
      unset: turnCeilingOf(undefined), empty: turnCeilingOf(""), zero: turnCeilingOf("0"), off: turnCeilingOf("off"), given: turnCeilingOf("25"), top: turnCeilingOf(500),
      over: turnCeilingOf(501), junk: turnCeilingOf("abc"), policy: buildRunPolicy({}).maxTurns,
    };
  },

  /** n475: the permit channel is opened: a sweep every minute hands a writer's ticket once to the PM of its run, and not again. */
  async m_action_channel() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const sends: Array<{ threadId: string; text: string }> = [];
    const registered: Array<{ name: string; cron: string }> = [];
    let sweep: () => Promise<void> = async () => undefined;
    const tickets = [{ session: "sess-a", ticket: "a1b2c3d4e5f60718", category: "delete_for_good", command: "rm data.csv", cwd: "/fixture/a", at: 1 }];
    const facade = {
      ...bb,
      background: { schedule: (name: string, cron: string, fn: () => Promise<void>) => { registered.push({ name, cron }); sweep = fn; } },
      hosts: { experimental_client: () => ({ call: async (method: string) => (method === "listPermitTickets" ? { tickets } : { written: true }) }) },
      sdk: { ...bb.sdk, threads: { send: async (payload: { threadId: string; input: Array<{ text: string }> }) => { sends.push({ threadId: payload.threadId, text: payload.input[0]!.text }); } } },
    };
    createRun(db, "run-a", "project");
    createTask(db, { id: "task-a", runId: "run-a", kind: "bb", contract: {} });
    createAttempt(db, { id: "a", runId: "run-a", taskId: "task-a" });
    transitionAttempt(db, "a", "spawn_requested");
    transitionAttempt(db, "a", "running", { threadId: "writer-a" });
    db.prepare("UPDATE lane_pilot_run SET writer_host_id=?,pm_thread_id=? WHERE id=?").run("host", "pm-a", "run-a");
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=? WHERE id=?").run("/fixture/a", "a");
    mountPermits({ bb: facade, db, isDisposed: () => false } as never);
    await sweep();
    const first = sends.map((send) => `${send.threadId}: ${send.text.slice(0, 96)}`);
    await sweep();
    return { registered, first, afterSecondSweep: sends.length };
  },

  /** n479: the door script takes the port's old rules away and lays loopback, WireGuard and the docker bridges first, then a drop for everyone else. */
  m_cfg_bind() {
    const dir = mkdtempSync(join(tmpdir(), "lp-door-"));
    try {
      mkdirSync(join(dir, "bin"));
      const log = join(dir, "ipt.log");
      writeFileSync(join(dir, "bin", "iptables"), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in -S) echo "-A INPUT -p tcp -m tcp --dport \${PORT_SEEN:-38886} -j DROP" ;; esac\nexit 0\n`);
      chmodSync(join(dir, "bin", "iptables"), 0o755);
      const run = (args: string[]) => {
        rmSync(log, { force: true });
        const done = spawnSync("bash", [join(process.cwd(), "scripts/bb-door.sh"), ...args], { env: { ...process.env, PORT_SEEN: args[0] ?? "38886", PATH: `${join(dir, "bin")}:${process.env.PATH}` }, encoding: "utf8" });
        const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
        return { exit: done.status, laid: lines.filter((line) => line.startsWith("-I ")), removed: lines.filter((line) => line.startsWith("-D ")).length };
      };
      return { standard: run([]), other: run(["4000"]) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },

  /** n483: a secret leaves the plugin as a name and a kind (it «is set»), never as its value: not in the list, not in a check, not in the log. */
  async m_cfg_secrets_view() {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { plugins: { callRpc: async ({ method }: { method: string }) => (method === "env_list"
        ? { variables: [{ name: "API_KEY", kind: "secret", value: "s3cr3t-value-77" }, { name: "SITE", kind: "login", value: "pw-in-list-88" }] }
        : { success: true }) } },
    } as never);
    const secrets = createSecrets({ bb });
    const list = await secrets.list({ fresh: true });
    const checked = await secrets.check({ declared: ["API_KEY", "NOPE"], allowed: [] }, { fresh: true });
    createCore(bb, openDatabase(bb));
    await secrets.save("DEPLOY_TOKEN", "tok-saved-12345");
    bb.log.warn("deploy failed with tok-saved-12345 in the url");
    const logged = harness.logEntries.map((entry) => entry.message).join("\n");
    const out = JSON.stringify({ list, checked });
    return { list, checkedMissing: checked.missing, leakedInResults: ["s3cr3t-value-77", "pw-in-list-88"].filter((text) => out.includes(text)), logLeaked: logged.includes("tok-saved-12345"), logLine: logged.split("\n").find((line) => line.startsWith("deploy failed")) ?? null };
  },

  /** n497: the «no movement» note is said once a day: a pass an hour later adds none, a pass a day later says it again with the new count. */
  async m_aging_mem() {
    const realNow = Date.now;
    const t0 = realNow();
    let clock = t0;
    Date.now = () => clock;
    try {
      const { phases, db } = phaseDriver();
      const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
      const notes = () => listParts(db, phase.id).filter((part) => part.kind === "aging").map((part) => part.text);
      await phases.tick();
      const fresh = notes();
      clock = t0 + 4 * DAY;
      await phases.tick();
      const firstDay = notes();
      clock = t0 + 4 * DAY + 2 * 3_600_000;
      await phases.tick();
      const sameDay = notes();
      clock = t0 + 5 * DAY + 3_600_000;
      await phases.tick();
      return { fresh, firstDay, sameDay, nextDay: notes() };
    } finally { Date.now = realNow; }
  },

  /** n498: a standing wave is named once: its table goes into the book when its first pieces are issued, and the next passes do not write it again. */
  async m_wave_wait_mem() {
    const w = phaseWorld();
    const items = [item("p1"), dep("p3", 2, "p1")];
    const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    const sha = planSignature(items, "ctx");
    savePhase(w.db, made.id, { stage: "execution", state: "active", runId: "run1", at: 2, record: { ...made.record, candidate: OFF, plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } }, objective: "o", premortem: ["a", "b", "c"] } } as never });
    const tables = () => listParts(w.db, made.id).filter((part) => part.kind === "wave_table").map((part) => part.text.split("\n")[0]);
    await w.phases.drive(getPhase(w.db, made.id)!);
    const first = tables();
    await w.phases.drive(getPhase(w.db, made.id)!);
    await w.phases.drive(getPhase(w.db, made.id)!);
    return { first, afterThree: tables(), issued: w.sent.map((task) => String(task.id)) };
  },

  /** n499, n500, n501: a task that ends is posted once to the project's https address with the nine fields; no address, no post. */
  async m_report() {
    const world = await webhookWorld("https://hooks.example.test/lp");
    return { posts: world.posts.map((post) => ({ url: post.url, method: post.method, event: post.body.event, state: post.body.state, taskId: post.body.taskId })), answerRead: world.answerRead };
  },
  async m_report_keys() {
    const world = await webhookWorld("https://hooks.example.test/lp", { display_title: "T".repeat(260), kind: "bb", diff: "SECRET DIFF", transcript: "SECRET TRANSCRIPT", token: "SECRET TOKEN" });
    const body = world.posts[0]?.body ?? {};
    return { keys: Object.keys(body), titleLength: String(body.title ?? "").length, leaked: ["SECRET DIFF", "SECRET TRANSCRIPT", "SECRET TOKEN"].filter((text) => JSON.stringify(body).includes(text)), attempt: body.attempt, kind: body.kind };
  },
  async m_report_off() {
    const none = await webhookWorld(null);
    const blank = await webhookWorld("   ");
    const plain = await webhookWorld("http://insecure.example.test/lp");
    return { noAddress: none.posts.length, blank: blank.posts.length, http: plain.posts.length };
  },

  /** n487: the stop verb and the restart verb drive the service manager: a stop issues the manager's stop and says it stopped; a restart issues the manager's own restart. */
  async m_ctl_cmd() {
    try {
      const w = watchdogWorld({ state: "inactive" });
      const stopped = watchdog(["stop"], w.e);
      const stopCalls = read(join(w.dir, "sys.log")).split("\n").filter((line) => /stop|restart|kill/.test(line));
      const r = watchdogWorld({ state: "active", door: "after3" });
      const restarted = watchdog(["restart"], r.e);
      await until(() => read(join(r.dir, "sys.log")).includes("restart bb-server"));
      return { stop: { status: stopped.status, first: stopped.stdout.split("\n")[0], calls: stopCalls }, restart: { status: restarted.status, last: lastLine(restarted.stdout), calls: read(join(r.dir, "sys.log")).split("\n").filter((line) => /stop|restart|kill/.test(line)) } };
    } finally { cleanupWatchdog(); }
  },

  /** n488: the service is identified by the manager's record (its MainPID) and by the door at the configured address — never by the name of a program. */
  m_ctl_identify() {
    try {
      const w = watchdogWorld({ state: "active", mainpid: "4242" });
      stub(w.dir, "pgrep", "echo 9999");
      stub(w.dir, "pidof", "echo 9999");
      const port = (door?: string) => functions('echo "$DOOR_PORT"', { ...w.e, ...(door ? { LP_WATCH_DOOR: door } : {}) }).trim();
      return { pid: functions("main_pid", w.e).trim(), port: port(), other: port("http://10.1.2.3:4555/install/version"), noPort: port("https://hub.example.test/install/version"), status: (watchdog(["status"], { ...w.e, CURL_AFTER: "0" }).stdout.split("\n")[0] ?? "").replace(/up \d+s/, "up <n>s") };
    } finally { cleanupWatchdog(); }
  },

  /** n489: the board request is the window's own `thread list` behind the same sign-in: a list is «ok», a sign-in refusal is «auth», anything else «unknown», no CLI «none». */
  m_ctl_probe() {
    try {
      const w = watchdogWorld({ state: "active" });
      const probe = (text: string | null) => functions("board_probe", { ...w.e, LP_WATCH_BB: text === null ? join(w.dir, "bin", "bb-missing") : stub(w.dir, "bb-x", text) }).trim();
      return { ok: probe("echo '[{\"id\":\"t1\"}]'"), auth: probe("echo 'error: not signed in (run bb auth login)'; exit 1"), notList: probe("echo '{\"threads\":[]}'"), noise: probe("echo 'warn: x' >&2; exit 3"), none: probe(null) };
    } finally { cleanupWatchdog(); }
  },

  /** n490: a service that is not running is stopped calmly: exit 0, one «stopped» line, no kill, nothing recorded as hard; asking again changes nothing. */
  m_ctl_not_running() {
    try {
      const w = watchdogWorld({ state: "inactive", mainpid: "0" });
      const first = watchdog(["stop"], w.e);
      const second = watchdog(["stop"], w.e);
      return { first: { status: first.status, line: first.stdout.split("\n")[0] }, second: { status: second.status, line: second.stdout.split("\n")[0] }, killed: /kill -s/.test(read(join(w.dir, "sys.log"))), hardRecorded: read(join(w.dir, "outages.jsonl")).includes("stopped_hard") };
    } finally { cleanupWatchdog(); }
  },

  /** n491: the door answers but the port is held by a process proven outside the unit: status, stop and restart say «process unproven», touch nothing and exit 2; --force goes on. */
  m_ctl_unnamed() {
    try {
      const other = holder();
      const w = watchdogWorld({ state: "active", mainpid: "4242", door: "up", ss: `LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=${other.pid},fd=1))\n`, extra: { UNIT_CG: "/lp-test.slice/bb-server.service", LP_WATCH_STOP_SEC: "1" } });
      const out: Record<string, { status: number; line: string }> = {};
      for (const verb of ["status", "stop", "restart"]) { const done = watchdog([verb], w.e); out[verb] = { status: done.status, line: (done.stdout.split("\n").find((line) => line.includes("process unproven")) ?? "").replace(String(other.pid), "<pid>") }; }
      const calls = read(join(w.dir, "sys.log"));
      const forced = watchdog(["stop", "--force"], w.e);
      return { out, touched: /stop --no-block|kill -s|restart bb-server/.test(calls), holderAlive: other.alive(), forced: (forced.stdout.split("\n").find((line) => line.includes("--force given")) ?? "").replace(String(other.pid), "<pid>"), stoppedAfterForce: read(join(w.dir, "sys.log")).includes("stop --no-block bb-server") };
    } finally { cleanupWatchdog(); }
  },

  /** n492: live work holds the stop: the refusal lists the workers and the stop is not issued until --force is said; an unreadable database does not hold it. */
  m_ctl_live_work() {
    try {
      const w = watchdogWorld({ state: "inactive", attempts: [["att1", "task1", "running", "thr1"], ["att2", "task2", "queued", null]] });
      const refused = watchdog(["stop"], w.e);
      const calls = () => read(join(w.dir, "sys.log")).split("\n").filter((line) => /stop|kill/.test(line));
      const refusedCalls = calls();
      const forced = watchdog(["stop", "--force"], w.e);
      const unreadable = watchdog(["stop"], { ...w.e, LP_WATCH_LP_DB: join(w.dir, "missing.db") });
      return { refused: { status: refused.status, lines: refused.stdout.trim().split("\n") }, issuedWhileRefused: refusedCalls, forced: { status: forced.status, issued: calls().length > 0 }, recorded: read(join(w.dir, "outages.jsonl")).split("\n").filter(Boolean).map((line) => JSON.parse(line).event), unreadable: { status: unreadable.status, line: unreadable.stdout.split("\n")[0] } };
    } finally { cleanupWatchdog(); }
  },

  /** n493: a stop the process does not obey is killed after the wait the unit allows, and said to have been hard. */
  m_ctl_killed() {
    try {
      const w = watchdogWorld({ state: "active" });
      const hard = watchdog(["stop"], { ...w.e, LP_WATCH_STOP_SEC: "3" });
      return { status: hard.status, line: hard.stdout.split("\n")[0], calls: read(join(w.dir, "sys.log")).split("\n").filter((line) => /stop|kill/.test(line)), waited: read(join(w.dir, "sleep.log")).split("\n").filter((line) => line === "1").length, recorded: read(join(w.dir, "outages.jsonl")).includes('"event":"stopped_hard"') };
    } finally { cleanupWatchdog(); }
  },

  /** n494: the restart waits for the door: it says how long it took when the door answers, and that it did not when the door stayed silent (exit 1). */
  m_ctl_restart() {
    try {
      const up = watchdogWorld({ state: "active", door: "after3", extra: { LP_WATCH_RESTART_WAIT_SEC: "30" } });
      const answered = watchdog(["restart"], up.e);
      const down = watchdogWorld({ state: "active", door: "down", extra: { LP_WATCH_RESTART_WAIT_SEC: "30" } });
      const silent = watchdog(["restart"], down.e);
      return { answered: { status: answered.status, last: lastLine(answered.stdout) }, silent: { status: silent.status, last: lastLine(silent.stdout) } };
    } finally { cleanupWatchdog(); }
  },

  /** n495: one lift command, chosen by the platform: launchctl on a Mac, sudo systemctl with sudo, systemctl --user without. */
  m_ctl_lift_cmd() {
    try {
      const { dir, env } = tmp();
      stub(dir, "sudo", "exit 0");
      const withSudo = { ...env, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
      return {
        mac: functions("lift_cmd", { ...env, LP_WATCH_PLATFORM: "darwin", LP_WATCH_SERVICE: "svc" }).trim().replace(/gui\/\d+\//, "gui/<uid>/"),
        sudo: functions("lift_cmd", withSudo).trim(), user: functions("lift_cmd", { ...env, LP_WATCH_USER: "1" }).trim(),
      };
    } finally { cleanupWatchdog(); }
  },

  /** n496: the exit code says what the machine is: 0 as asked, 1 failed or down, 2 a refusal that a flag would lift (live work, a foreign door). */
  m_ctl_exit() {
    try {
      const other = holder();
      const up = watchdogWorld({ state: "active", mainpid: "4242", door: "up", ss: "" });
      const down = watchdogWorld({ state: "inactive", door: "down" });
      const busy = watchdogWorld({ state: "inactive", attempts: [["att1", "task1", "running", "thr1"]] });
      const foreign = watchdogWorld({ state: "active", mainpid: "4242", door: "up", ss: `LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=${other.pid},fd=1))\n`, extra: { UNIT_CG: "/lp-test.slice/bb-server.service" } });
      return {
        answers: watchdog(["status"], up.e).status, down: watchdog(["status"], down.e).status, liveWork: watchdog(["stop"], busy.e).status,
        forcedLiveWork: watchdog(["stop", "--force"], busy.e).status, foreignDoor: watchdog(["status"], foreign.e).status, foreignForced: watchdog(["stop", "--force"], foreign.e).status,
      };
    } finally { cleanupWatchdog(); }
  },

  /** n502: the digest is made from the live settings at every call: switching the owner push off or on is heard at the next tick, with no restart. */
  m_sum_build() {
    const { db } = scratch();
    postOwnerItem(db, { key: "night:a", source: "night", kind: "proposal", what: "First", why: "posted by a caller", evidence: [], actions: [] }, NOW);
    const on = planDigest(db, NOW);
    savePushConfig(db, { enabled: "off" }, NOW);
    const off = planDigest(db, NOW);
    savePushConfig(db, { enabled: "on" }, NOW);
    const back = planDigest(db, NOW);
    ackDigest(db, back.keys, NOW);
    const after = planDigest(db, NOW + 3_600_000);
    return { on: { send: on.send, keys: on.keys, text: on.text.split("\n")[0] }, off: { send: off.send, reason: off.reason }, back: { send: back.send, keys: back.keys }, after: { send: after.send, reason: after.reason } };
  },
};

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22, 7, 0, 0);
const OFF = { branch: "phase/test", trees: {}, off: "no phase branch in this test" };

/** daemon-tick-1's driver: the real phase driver on a scratch database and a PM thread that is idle. */
function phaseDriver() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services).phases;
  return { phases, db };
}

type Post = { url: string; method: string; body: Record<string, unknown> };
/** mountOutbound on a scratch database with a stand-in `fetch`; one attempt blocks, is re-queued, blocks again, then lands. */
async function webhookWorld(url: string | null, contract: Record<string, unknown> = { display_title: "Fix the bar", kind: "bb" }) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  if (url !== null) saveProjectSetting(db, "proj", "events.webhook_url", url);
  createRun(db, "run", "proj", "bb");
  createTask(db, { id: "T1", runId: "run", kind: "bb", contract: contract as never });
  createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
  const posts: Post[] = [];
  let answerRead = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (target: unknown, init: { method: string; body: string }) => {
    posts.push({ url: String(target), method: init.method, body: JSON.parse(init.body) });
    return { json: () => { answerRead = true; return {}; }, text: () => { answerRead = true; return ""; }, ok: true } as never;
  }) as never;
  try {
    mountOutbound({ db, bb, log: () => undefined, isDisposed: () => false } as never);
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "w1" });
    transitionAttempt(db, "a1", "blocked", { reason: "gate" });
    transitionAttempt(db, "a1", "queued");
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "w1" });
    transitionAttempt(db, "a1", "blocked", { reason: "gate again" });
    transitionAttempt(db, "a1", "queued");
    transitionAttempt(db, "a1", "accepted");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { globalThis.fetch = realFetch; }
  return { posts, answerRead };
}

const lastLine = (text: string) => text.trim().split("\n").pop() ?? "";

/** A scratch state folder for hub-watchdog.sh with stand-in curl, systemctl, sleep and ss, a scratch attempts table, and the environment that points the script at them. */
function watchdogWorld(options: { state: string; mainpid?: string; door?: "up" | "after3" | "down"; attempts?: Array<Array<string | null>>; ss?: string; extra?: Record<string, string> }) {
  const { dir, env } = tmp();
  stub(dir, "curl", CURL_STUB);
  stub(dir, "sleep", SLEEP_STUB);
  const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
  stub(dir, "ss", SS_STUB);
  const db = join(dir, "data.db");
  const rows = (options.attempts ?? []).map((row) => `insert into lane_pilot_attempt values(${row.map((cell) => (cell === null ? "null" : `'${cell}'`)).join(",")});`).join("");
  execFileSync("sqlite3", [db, `create table lane_pilot_attempt(id,task_id,state,thread_id);${rows}`]);
  writeFileSync(join(dir, "state"), `${options.state}\n`);
  writeFileSync(join(dir, "mainpid"), `${options.mainpid ?? "4242"}\n`);
  writeFileSync(join(dir, "ss.out"), options.ss ?? "");
  const door: Record<string, string> = options.door === "up" ? { CURL_AFTER: "0" } : options.door === "after3" ? { CURL_AFTER: "3" } : { CURL_AFTER: "999999", CURL_CODE: "000", CURL_RC: "28" };
  const e = { ...env, ...door, CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), SLEEP_LOG: join(dir, "sleep.log"), SS_OUT: join(dir, "ss.out"), STATE_FILE: join(dir, "state"), MAINPID_FILE: join(dir, "mainpid"),
    LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db, ...(options.extra ?? {}) };
  return { dir, e };
}
