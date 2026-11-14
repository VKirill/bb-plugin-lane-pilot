// Region 12 · Supervisor — behaviour tests of the four proofs for the nodes that had no test of their own, or only a weak one.
// The drill scenes are judged here with fakes passed in (no model, no hub); the watchdog script runs for real against stub tools.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { grantRunFolders } from "../../src/rooms/verification/worker-user";
import { cleanupWatchdog, CURL_STUB, SLEEP_STUB, SS_STUB, SYSTEMCTL_STUB, functions, run, script, stub, tmp, until } from "../helpers/hub-watchdog";

afterEach(cleanupWatchdog);

const root = process.cwd();
const drillFile = join(root, "scripts/lp-drill.py");

/** Runs python against the drill's scene modules (scripts/lp_drill) and prints one JSON value. */
function py(body: string): any { // guardian: allow: a python probe prints free-shaped JSON, each test asserts the fields it reads
  const code = `
import sys, json, os, tempfile, pathlib
sys.path.insert(0, ${JSON.stringify(join(root, "scripts"))})
from unittest import mock
${body}
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 90_000 });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 1200));
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

describe("supervisor drills: the judging of the scene, with the hub and the model replaced by fakes", () => {
  it("[sma:m_sd_clean_done] a verification receipt counts only when it lists checks and every one exited 0; an empty list, a red check or no receipt is «not run»", () => {
    const out = py(`
from lp_drill.scenes import writers as w
rows = [
  {"task_id": "t1", "result_json": json.dumps({"verification": [{"exitCode": 0}]})},
  {"task_id": "t2", "result_json": json.dumps({"verification": [{"exitCode": 1}]})},
  {"task_id": "t3", "result_json": json.dumps({"verification": []})},
  {"task_id": "t5", "result_json": json.dumps({"verification": [{"exitCode": 0}, {"exitCode": 2}]})},
]
class C: run_id = "r1"
with mock.patch.object(w, "hubsql", lambda sql: rows):
    ran = w.verification_ran(C(), ["t1", "t2", "t3", "t4", "t5"])
# the scene itself: a task accepted with no green check on record is a problem
tmpd = tempfile.mkdtemp()
class Ctx:
    run_id = "r1"; cwd = tmpd; dispatches = {}
    def dispatch(self, spec): return True
    def wait_ended(self, ids, minutes=None): return []
def summarize(rows, tid, cwd, output=None):
    return {"task": tid, "state": "accepted", "states": ["accepted"], "reason": "", "workspace": "/w/" + tid, "attempt": "a-" + tid, "fileInSandbox": True, "environment": "env", "holder": None}
def scene(ran_map):
    with mock.patch.object(w, "summarize", summarize), mock.patch.object(w, "verification_ran", lambda ctx, ids: {i: ran_map for i in ids}), \\
         mock.patch.object(w, "worktree_registry", lambda attempts: {}), mock.patch.object(w, "worktree_leftovers", lambda *a: []), mock.patch.object(w, "cleanup_schedule_rows", lambda: []), mock.patch.object(w, "cleanup_schedule_problems", lambda rows: []):
        return w.scenario_parallel3(Ctx())
green, red = scene(True), scene(False)
print(json.dumps({"ran": ran, "green": [green["result"], green["problems"]], "red": [red["result"], red["problems"]]}))
`);
    expect(out.ran).toEqual({ t1: true, t2: false, t3: false, t4: false, t5: false });
    expect(out.green).toEqual(["pass", []]);
    expect(out.red[0]).toBe("fail");
    expect(out.red[1].some((line: string) => line.includes("did not run the task's check with exit 0"))).toBe(true);
  });

  it("[sma:m_sd_smoke] three notes: all accepted, each in its own worktree and with a green check is a pass; one not accepted or two sharing a worktree is named", () => {
    const out = py(`
from lp_drill.scenes import writers as w
tmpd = tempfile.mkdtemp()
class Ctx:
    run_id = "r1"; cwd = tmpd; dispatches = {}
    def dispatch(self, spec): return True
    def wait_ended(self, ids, minutes=None): return []
def scene(states, spaces):
    def summarize(rows, tid, cwd, output=None):
        i = "abc".index(tid[-1])
        return {"task": tid, "state": states[i], "states": [states[i]], "reason": "", "workspace": spaces[i], "attempt": "a" + str(i), "fileInSandbox": True, "environment": "env", "holder": None}
    with mock.patch.object(w, "summarize", summarize), mock.patch.object(w, "verification_ran", lambda ctx, ids: {i: True for i in ids}), \\
         mock.patch.object(w, "worktree_registry", lambda attempts: {}), mock.patch.object(w, "worktree_leftovers", lambda *a: []), mock.patch.object(w, "cleanup_schedule_rows", lambda: []), mock.patch.object(w, "cleanup_schedule_problems", lambda rows: []):
        out = w.scenario_parallel3(Ctx())
    return [out["result"], out["problems"], out["checks"]["allAccepted"], out["checks"]["eachInOwnWorktree"]]
print(json.dumps({
  "good": scene(["accepted"] * 3, ["/w/a", "/w/b", "/w/c"]),
  "one_blocked": scene(["accepted", "blocked", "accepted"], ["/w/a", "/w/b", "/w/c"]),
  "shared": scene(["accepted"] * 3, ["/w/a", "/w/a", "/w/c"]),
}))
`);
    expect(out.good).toEqual(["pass", [], true, true]);
    expect(out.one_blocked[0]).toBe("fail");
    expect(out.one_blocked[1]).toContain("not every task was accepted");
    expect(out.one_blocked[2]).toBe(false);
    expect(out.shared[0]).toBe("fail");
    expect(out.shared[1]).toContain("tasks did not each get a worktree of their own");
    expect(out.shared[3]).toBe(false);
  });

  it("[sma:m_sd_answer] in a series the answer-only task must close on its answer the first time, with an answer on record; one that needed two attempts or left no receipt is named", () => {
    const out = py(`
from lp_drill.scenes import writers as w
os.environ["LP_DRILL_SERIES"] = "1"
tmpd = tempfile.mkdtemp()
class Ctx:
    run_id = "r1"; cwd = tmpd
    def dispatch(self, spec): return True
    def wait_ended(self, ids): return []
def scene(answer_state, attempts, receipts, noedit_state):
    def summarize(rows, tid, cwd, output=None):
        if "answer" in tid: return {"state": answer_state, "states": [answer_state], "reason": "r", "attempts": attempts}
        if "human" in tid: return {"state": "blocked", "states": ["blocked"], "reason": "NEEDS_HUMAN: colour"}
        return {"state": noedit_state, "states": [noedit_state], "reason": ""}
    with mock.patch.object(w, "summarize", summarize), mock.patch.object(w, "hubsql", lambda sql: [{"n": receipts}]):
        return w.scenario_no_code_exit(Ctx())["problems"]
print(json.dumps({
  "good": scene("accepted", 1, 1, "blocked"),
  "twice": scene("accepted", 2, 1, "blocked"),
  "blocked": scene("blocked", 1, 1, "blocked"),
  "no_receipt": scene("accepted", 1, 0, "blocked"),
  "noedit_accepted": scene("accepted", 1, 1, "accepted"),
}))
`);
    expect(out.good).toEqual([]);
    expect(out.twice).toEqual(["edit-free answer work needed 2 attempts to close on its answer"]);
    expect(out.blocked.some((line: string) => line.includes("did not close on its answer the first time"))).toBe(true);
    expect(out.no_receipt).toEqual(["the answer task was accepted with no answer on record (no writer-agent receipt)"]);
    expect(out.noedit_accepted).toEqual(["code work told to change nothing was accepted"]);
  });

  it("[sma:m_sd_approve] a red task (its check fails) must not be accepted without a word, must offer no owner item, and an RPC yes must not land it; the green one lands after the press", () => {
    const out = py(`
from lp_drill.scenes import owner as o
os.environ["LP_DRILL_LIVE_PRESS"] = "1"
def scene(red_state, red_items, green_state="accepted", rpc_lands=False):
    tmpd = pathlib.Path(tempfile.mkdtemp())
    class Ctx:
        project = "proj_x"; run_id = "run_abc"; pm = "thr"; cwd = str(tmpd); tmp = tmpd
        def dispatch(self, spec): return True
        def wait_ended(self, ids): return []
        def rows(self, ids): return []
    def summarize(rows, tid, cwd, output=None):
        state = red_state if "red" in tid else green_state
        return {"state": state, "states": [state], "reason": ""}
    with mock.patch.object(o, "owner_words", lambda ctx, v: ("off", 1)), mock.patch.object(o, "restore_owner_words", lambda ctx, orig, v: []), \\
         mock.patch.object(o, "thread_text", lambda t: "waits for the owner's word before it lands"), mock.patch.object(o.time, "sleep", lambda s: None), \\
         mock.patch.object(o, "hubsql", lambda sql: [{"n": red_items}]), mock.patch.object(o, "latest_states", lambda rows: {"drill-word-red": "accepted"} if rpc_lands else {}), \\
         mock.patch.object(o, "summarize", summarize), mock.patch.object(o, "setting_rpc", lambda m, p: {"ok": True}), mock.patch.object(o, "run", lambda args, **k: (0, "", "")):
        out = o.scenario_live_word(Ctx())
    return [out["result"], out["problems"]]
print(json.dumps({
  "good": scene("blocked", 0),
  "red_accepted": scene("accepted", 0),
  "red_item": scene("blocked", 1),
  "green_not_landed": scene("blocked", 0, green_state="blocked"),
}))
`);
    expect(out.good).toEqual(["pass", []]);
    expect(out.red_accepted[0]).toBe("fail");
    expect(out.red_accepted[1]).toContain("a task whose check failed was accepted without a word");
    expect(out.red_item[1]).toContain("the red task offered an owner item anyway");
    expect(out.green_not_landed[1].some((line: string) => line.startsWith("the task did not land after the word"))).toBe(true);
  });

  it("[sma:m_sd_merge] a revert is judged by a merged receipt of kind revert, not by the word", () => {
    const out = py(`
from lp_drill.scenes import revert as r
f = lambda receipts: r.revert_merged(json.dumps({"receipts": receipts, "summary": "revert is mentioned here"}))
print(json.dumps({"merged": f([{"kind": "revert", "state": "merged"}]), "dry": f([{"kind": "revert", "state": "dry_run"}]), "other": f([{"kind": "reverify", "state": "merged"}]), "none": f([])}))
`);
    expect(out).toEqual({ merged: true, dry: false, other: false, none: false });
  });
});

describe("supervisor drill: day rotation (the watchdog scenario of lp-drill.py)", () => {
  const scene = (rotates: boolean) => py(`
import importlib.util, threading, http.server, subprocess as realsp
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drillFile)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b"v")
    def log_message(self, *a): pass
server = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
door = f"http://127.0.0.1:{server.server_address[1]}/install/version"
bindir = tempfile.mkdtemp()
open(os.path.join(bindir, "ss"), "w").write("#!/bin/sh\\nexit 0\\n"); os.chmod(os.path.join(bindir, "ss"), 0o755)
class P:
    def terminate(self): pass
    def wait(self, timeout=None): return 0
def popen(args, env=None, **k):
    state = pathlib.Path(env["LP_WATCH_STATE"])
    (state / "outages.jsonl").write_text('{"at":1,"event":"outage","detail":"x"}\\n{"at":2,"event":"lift","detail":"x"}\\n')
    return P()
class FakeSubprocess:
    Popen = staticmethod(popen); DEVNULL = realsp.DEVNULL; TimeoutExpired = realsp.TimeoutExpired
def fake_run(args, env=None, timeout=None):
    env = dict(env or {}); env["PATH"] = bindir + ":" + env.get("PATH", "")
    if args[-1] == "lift": env["LP_WATCH_DOOR"] = door
    if args[-1] == "rotate" and not ${rotates ? "True" : "False"}: return 0, "", ""
    done = realsp.run(args, env=env, capture_output=True, text=True, timeout=60)
    return done.returncode, done.stdout, done.stderr
with mock.patch.object(m, "subprocess", FakeSubprocess), mock.patch.object(m, "run", fake_run), mock.patch.object(m.time, "sleep", lambda s: None):
    out = m.scenario_watchdog(pathlib.Path(tempfile.mkdtemp()))
print(json.dumps({"result": out["result"], "problems": out["problems"]}))
`);

  it("[sma:m_sp_rotation_drill] a log whose line is of an old day is rotated to outages-<day>.jsonl, and the scene fails when it is not", () => {
    expect(scene(true)).toEqual({ result: "pass", problems: [] });
    const broken = scene(false);
    expect(broken.result).toBe("fail");
    expect(broken.problems).toEqual(["an old log did not rotate to its day"]);
  }, 60_000);
});

describe("supervisor watchdog: the start lift, readiness and the startup entries", () => {
  it("[sma:m_sp_start_ps] one lift command per platform; a lift restarts the service and returns only when the door answers, else records that it waited out", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    stub(dir, "sleep", SLEEP_STUB);
    stub(dir, "ss", SS_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const base = { ...env, CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), SLEEP_LOG: join(dir, "sleep.log"), MAINPID_FILE: join(dir, "mainpid"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_SERVICE: "lp-start" };
    expect(functions("lift_cmd", { ...base, LP_WATCH_PLATFORM: "darwin" }).trim()).toBe(`launchctl kickstart -k gui/${userInfo().uid}/lp-start`);
    expect(functions("lift_cmd", base).trim()).toBe(`${sys} --user restart lp-start`);
    // the door answers on the third knock: the lift returns 0 and the manager was asked to restart exactly this service
    const rose = functions("lift; echo rc=$?", { ...base, CURL_AFTER: "2" });
    expect(rose).toContain("rc=0");
    expect(readFileSync(join(dir, "sys.log"), "utf8")).toContain("--user restart lp-start");
    // the door never answers: the lift does not claim success
    rmSync(join(dir, "outages.jsonl"), { force: true });
    const stuck = functions("lift; echo rc=$?", { ...base, ...{ CURL_AFTER: "999999", CURL_CODE: "000", CURL_RC: "28" }, LP_WATCH_MAX_LIFTS: "1" });
    expect(stuck).toContain("rc=1");
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toContain("lift_without_outcome");
  }, 30_000);

  it("[sma:m_sp_sql_ready] a path that is not a database file is «missing» and fails the readiness, though nothing else is wrong", () => {
    const { dir, env } = tmp();
    const ok = join(dir, "ok.db");
    execFileSync("sqlite3", [ok, "CREATE TABLE t(x);"]);
    const missing = join(dir, "no-such.db");
    const onlyMissing = run(["db-ready"], { ...env, LP_WATCH_DBS: missing });
    expect(onlyMissing.status).toBe(1);
    expect(onlyMissing.stdout).toContain(`missing: ${missing}`);
    const onlyOk = run(["db-ready"], { ...env, LP_WATCH_DBS: ok });
    expect(onlyOk.status).toBe(0);
    expect(onlyOk.stdout.split("\n")).toContain(`ready: ${ok}`);
  });

  it("[sma:m_sp_pg_ready] [sma:m_sp_pg_sandbox] a database that answers quick_check but is not UTF-8 is not ready; one that is corrupt is not ready; a good one is", () => {
    const { dir, env } = tmp();
    const good = join(dir, "good.db");
    const wide = join(dir, "wide.db");
    const corrupt = join(dir, "corrupt.db");
    execFileSync("sqlite3", [good, "CREATE TABLE t(x);"]);
    execFileSync("sqlite3", [wide, "PRAGMA encoding='UTF-16le'; CREATE TABLE t(x); INSERT INTO t VALUES ('a');"]);
    writeFileSync(corrupt, "this is not a database");
    const result = run(["db-ready"], { ...env, LP_WATCH_DBS: `${good} ${wide} ${corrupt}` });
    expect(result.status).toBe(1);
    expect(result.stdout.split("\n")).toContain(`ready: ${good}`);
    expect(result.stdout).toMatch(new RegExp(`not ready: ${wide.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(ok, UTF-16le\\)`));
    expect(result.stdout).toContain(`not ready: ${corrupt}`);
    expect(result.stdout).not.toContain(`ready: ${wide}\n`);
    expect(run(["db-ready"], { ...env, LP_WATCH_DBS: wide }).status).toBe(1);
  });

  it("[sma:m_sp_task_xml] the system startup entry runs the watchdog loop under the manager and registers nothing", () => {
    const { dir, env } = tmp();
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const self = realpathSync(script);
    const out = run(["print-unit", "system"], { ...env, HOME: dir, SYS_LOG: join(dir, "sys.log"), LP_WATCH_SYSTEMCTL: sys });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`ExecStart=/bin/bash ${self} run`);
    expect(out.stdout).toContain("Restart=always");
    expect(out.stdout).toContain("RestartSec=30");
    expect(out.stdout).toContain("WantedBy=multi-user.target");
    expect(existsSync(join(dir, "sys.log"))).toBe(false);
    expect(readdirSync(dir).filter((name) => name !== "bin")).toEqual([]);
  });

  it("[sma:m_sp_logon_xml] the user startup entry starts at login, waits 30 s between restarts and carries the restart cap the setting names", () => {
    const { env } = tmp();
    const self = realpathSync(script);
    const out = run(["print-unit", "user"], env).stdout;
    expect(out).toContain(`ExecStart=/bin/bash ${self} run`);
    expect(out).toContain("WantedBy=default.target");
    expect(out).toContain("RestartSec=30");
    expect(out).toContain("Environment=LP_WATCH_FIRST_SEC=120");
    expect(out).toContain("StartLimitIntervalSec=3600");
    expect(out).toContain("StartLimitBurst=5");
    expect(run(["print-unit", "user"], { ...env, LP_WATCH_RESTART_CAP: "3" }).stdout).toContain("StartLimitBurst=3");
    expect(run(["print-unit", "user"], { ...env, LP_WATCH_RESTART_CAP: "0" }).stdout).not.toContain("StartLimit");
  });

  it("[sma:m_sp_plist] the Mac startup entry starts the watchdog loop at login and keeps it alive on any exit", () => {
    const { dir, env } = tmp();
    const self = realpathSync(script);
    const plist = run(["print-unit", "mac"], env).stdout;
    expect(plist).toContain("<key>Label</key><string>pro.vechkasov.lp-hub-watchdog</string>");
    expect(plist).toContain(`<string>/bin/bash</string><string>${self}</string><string>run</string>`);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>720</integer>");
    expect(plist).toContain(`<key>StandardOutPath</key><string>${dir}/hub-watchdog.log</string>`);
  });

  it("[sma:m_sp_spawn_logged] the Mac entry's output goes to the watchdog log, and the lift and the restart verb run one and the same manager command", async () => {
    const { dir, env } = tmp();
    const plist = run(["print-unit", "mac"], env).stdout;
    expect(plist).toContain(`<key>StandardOutPath</key><string>${dir}/hub-watchdog.log</string><key>StandardErrorPath</key><string>${dir}/hub-watchdog.log</string>`);
    stub(dir, "curl", CURL_STUB);
    stub(dir, "sleep", SLEEP_STUB);
    stub(dir, "ss", SS_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const common = { ...env, CURL_STATE: join(dir, "s"), SLEEP_LOG: join(dir, "sleep.log"), MAINPID_FILE: join(dir, "mainpid"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_SERVICE: "lp-shared", LP_WATCH_LP_DB: join(dir, "none.db") };
    functions("service_restart", { ...common, SYS_LOG: join(dir, "lift.log") });
    run(["restart"], { ...common, SYS_LOG: join(dir, "restart.log"), CURL_AFTER: "0", LP_WATCH_RESTART_SETTLE_SEC: "0", LP_WATCH_RESTART_WAIT_SEC: "0" });
    expect(await until(() => existsSync(join(dir, "restart.log")) && readFileSync(join(dir, "restart.log"), "utf8").includes("restart"))).toBe(true);
    const restartLine = readFileSync(join(dir, "restart.log"), "utf8").split("\n").filter((line) => line.includes("restart"));
    expect(restartLine).toEqual(["--user restart lp-shared"]);
    expect(readFileSync(join(dir, "lift.log"), "utf8").split("\n").filter((line) => line.includes("restart"))).toEqual(restartLine);
  }, 30_000);

  it("[sma:m_sp_setup_mac] the Mac guide names the agent file the install really writes, and says it starts at login and stays alive", () => {
    const { dir, env } = tmp();
    const guide = readFileSync(join(root, "docs/watchdog.md"), "utf8");
    const section = guide.slice(guide.indexOf("## macOS"), guide.indexOf("## Windows"));
    const label = /~\/Library\/LaunchAgents\/(\S+?\.plist)/.exec(section)?.[1];
    expect(label).toBeDefined();
    expect(section).toContain("RunAtLoad");
    expect(section).toContain("KeepAlive");
    mkdirSync(join(dir, "Library/LaunchAgents"), { recursive: true });
    stub(dir, "launchctl", "exit 0");
    const installed = run(["install"], { ...env, HOME: dir, LP_WATCH_PLATFORM: "darwin" });
    expect(installed.stdout).toContain("installed: LaunchAgent pro.vechkasov.lp-hub-watchdog");
    const written = join(dir, "Library/LaunchAgents", label!);
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("<key>RunAtLoad</key><true/>");
  }, 60_000);

  it("[sma:m_sp_setup_win] the Windows guide is in Russian and gives the logon task with the watchdog's own run command", () => {
    const guide = readFileSync(join(root, "docs/watchdog.md"), "utf8");
    const section = guide.slice(guide.indexOf("## Windows"));
    expect(section).toMatch(/[А-Яа-я]{5}/);
    expect(section).toContain("schtasks /Create /SC ONLOGON");
    expect(section).toContain("hub-watchdog.sh run");
    expect(readFileSync(script, "utf8")).toMatch(/Usage[^\n]*\brun\b/);
  });

  it("[sma:m_sp_lift_ps] without administrator rights the Windows guide puts a shortcut in the startup folder with the same command", () => {
    const guide = readFileSync(join(root, "docs/watchdog.md"), "utf8");
    const section = guide.slice(guide.indexOf("## Windows"));
    const noAdmin = section.split("\n").find((line) => line.includes("Без прав администратора"));
    expect(noAdmin).toBeDefined();
    expect(noAdmin).toContain("`shell:startup`");
    expect(noAdmin).toContain("той же командой");
  });
});

describe("supervisor: grants ledger and the plugin database", () => {
  const hasSetfacl = spawnSync("sh", ["-c", "command -v setfacl"]).status === 0;

  it("[sma:m_sp_grant_rows] every granted folder is a row of the ledger with who got it and who keeps it; a folder that could not be granted is not listed", async (context) => {
    if (!hasSetfacl) return context.skip();
    const home = mkdtempSync(join(tmpdir(), "lp-grants-home-"));
    const good = mkdtempSync(join(tmpdir(), "lp-grants-run-"));
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      const user = userInfo().username;
      const granted = await grantRunFolders(user, [good, join(good, "no", "such", "folder")], "linux");
      expect(granted).toEqual([good]);
      const rows = readFileSync(join(home, ".lane-pilot", "worker-grants.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user, owner: user, path: good });
      expect(typeof rows[0].at).toBe("number");
      expect(await grantRunFolders(user, [], "linux")).toEqual([]);
      expect(readFileSync(join(home, ".lane-pilot", "worker-grants.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
      rmSync(home, { recursive: true, force: true });
      rmSync(good, { recursive: true, force: true });
    }
  });

  it("[sma:m_sp_pg_db] opening the plugin database again over an existing one is a success and keeps what it holds (the consuming half; the migrate itself is bb-core's)", () => {
    const host = createFakePluginHost({ pluginId: "lane-pilot" });
    const tables = (db: ReturnType<typeof openDatabase>) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
    const first = openDatabase(host.bb);
    expect(tables(first)).toContain("lane_pilot_run");
    first.prepare("INSERT INTO lane_pilot_run (id, project_id, state, created_at, updated_at) VALUES ('r_exists', 'p', 'pending', 1, 1)").run();
    let second: ReturnType<typeof openDatabase> | undefined;
    expect(() => { second = openDatabase(host.bb); }).not.toThrow();
    expect(tables(second!)).toContain("lane_pilot_run");
    expect((second!.prepare("SELECT count(*) AS n FROM lane_pilot_run WHERE id = 'r_exists'").get() as { n: number }).n).toBe(1);
  });
});
