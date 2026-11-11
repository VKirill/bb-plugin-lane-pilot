import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWatchdog, script, pushScript, drillPy, run, functions, stub, CURL_STUB, SYSTEMCTL_STUB, SLEEP_STUB, until, read, pathWithout, tmp, silentDoor } from "../helpers/hub-watchdog";

// One of three files (parity-d1-watchdog, -2, -3): the tests wait in real time for the watchdog's knocks, so they are spread over three
// files that run in separate workers. What they share is tests/helpers/hub-watchdog.ts.
afterEach(cleanupWatchdog);

describe("hub watchdog parity D1", () => {
  it("[sma:m_ctl_probe] the HTTP 200 alone says the hub answers: a board request that fails, is noisy or hangs is advisory, never an outage, a lift or a failed status", async () => {
    const variants: Record<string, string> = {
      "bb exits 127 (no node on the PATH)": "echo 'env: node: No such file or directory' >&2; exit 127",
      "bb prints noise on stderr and a reply that is no array": "echo 'warn: something' >&2; echo '{\"threads\":[]}'",
      "bb times out": "exit 0",
    };
    // The variants each run their own watchdog in their own folder: the three 4.5-second waits run together.
    await Promise.all(Object.entries(variants).map(async ([name, text]) => {
      const { dir, env } = tmp();
      stub(dir, "curl", CURL_STUB);
      const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
      stub(dir, "timeout", name === "bb times out" ? "exit 124" : 'shift; exec "$@"'); // 124 is what timeout(1) returns when it cut the command
      const bb = stub(dir, "bb", text);
      writeFileSync(join(dir, "mainpid"), "4242\n");
      writeFileSync(join(dir, "state"), "active\n");
      const e = { ...env, CURL_AFTER: "0", CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_BB: bb, LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1", LP_WATCH_BOARD_EVERY: "1" };
      expect(functions("door_probe", e).trim(), name).toBe("ok");
      expect(functions("board_probe", e).trim(), name).toBe("unknown");
      const status = run(["status"], e);
      expect(status.status, name).toBe(0);
      expect(status.stdout, name).toContain("board request (advisory): unknown");
      expect(functions("lift", e), name).toContain("nothing to do: the door answers");
      const proc = spawn("bash", [script, "run"], { env: { ...process.env, ...e }, stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 4500));
      proc.kill("SIGTERM");
      const log = read(join(dir, "outages.jsonl"));
      expect(log, name).not.toContain('"event":"outage"');
      expect(log, name).not.toContain('"event":"lift"');
      expect(log, name).toContain('"event":"board_unknown"');
      expect(read(join(dir, "sys.log")), name).not.toMatch(/kill -s|restart bb-server|stop --no-block/);
    }));
    // the clean results still count: a signed-out CLI says auth, a bare array says ok
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const base = { ...env, CURL_AFTER: "0" };
    expect(functions("board_probe", { ...base, LP_WATCH_BB: stub(dir, "bb-auth", "echo 'error: not signed in (run bb auth login)'; exit 1") }).trim()).toBe("auth");
    expect(functions("board_probe", { ...base, LP_WATCH_BB: stub(dir, "bb-ok", "echo '[]'") }).trim()).toBe("ok");
    expect(functions("board_probe", env).trim()).toBe("none");
  }, 60000);

  it("[sma:m_ctl_live_work] a stop refuses while live work was read (every open attempt state), listing the workers, until --force is said; a database that cannot be read is 'unknown: proceeding'", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const db = join(dir, "data.db");
    execFileSync("sqlite3", [db, "create table lane_pilot_attempt(id,task_id,state,thread_id); insert into lane_pilot_attempt values('att1','task1','running','thr1');"]);
    writeFileSync(join(dir, "state"), "inactive\n");
    const e = { ...env, ...silentDoor, CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db };
    const refused = run(["stop"], e);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain("refused: live work holds the stop");
    expect(refused.stdout).toContain("att1 task1 thr1");
    expect(read(join(dir, "sys.log"))).not.toContain("stop --no-block");
    const forced = run(["stop", "--force"], e);
    expect(forced.status).toBe(0);
    expect(read(join(dir, "sys.log"))).toContain("stop --no-block bb-server");
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toContain('"event":"stop_forced"');
    // the repo's open attempt states all hold the stop; a finished one does not
    for (const state of ["queued", "spawn_requested", "spawn_unknown", "cancel_requested"]) {
      execFileSync("sqlite3", [db, `delete from lane_pilot_attempt; insert into lane_pilot_attempt values('att2','task2','${state}',null);`]);
      const out = run(["stop"], e);
      expect(out.status, state).toBe(2);
      expect(out.stdout, state).toContain("att2 task2 -");
    }
    execFileSync("sqlite3", [db, "delete from lane_pilot_attempt; insert into lane_pilot_attempt values('att3','task3','accepted','thr3');"]);
    expect(run(["stop"], e).status).toBe(0);
    // unreadable: no database, no sqlite3, a query that fails: proceeds and says so
    const noDb = run(["stop"], { ...e, LP_WATCH_LP_DB: join(dir, "missing.db") });
    expect(noDb.status).toBe(0);
    expect(noDb.stdout).toContain("unknown live work: the Lane Pilot database cannot be read");
    expect(noDb.stdout).toContain("proceeding");
    const broken = join(dir, "broken.db");
    writeFileSync(broken, "not a database at all");
    expect(run(["stop"], { ...e, LP_WATCH_LP_DB: broken }).stdout).toContain("proceeding");
    const noSqlite = run(["stop"], { ...e, PATH: `${join(dir, "bin")}:${pathWithout("sqlite3")}` });
    expect(noSqlite.status).toBe(0);
    expect(noSqlite.stdout).toContain("proceeding");
  }, 30000);

  it("[sma:m_ctl_restart] [sma:m_ctl_lift_cmd] restart does what main does: the manager's own restart, launched detached before anything is stopped; the stop refusals stand; its last line says whether the door answered", async () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    stub(dir, "sleep", SLEEP_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const db = join(dir, "data.db");
    execFileSync("sqlite3", [db, "create table lane_pilot_attempt(id,task_id,state,thread_id);"]);
    writeFileSync(join(dir, "state"), "active\n");
    const base = { ...env, CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), SLEEP_LOG: join(dir, "sleep.log"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db, LP_WATCH_RESTART_WAIT_SEC: "30" };
    const ok = run(["restart"], { ...base, CURL_AFTER: "3" });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim().split("\n").pop()).toMatch(/^ok: the door answers after \d+s$/);
    expect(await until(() => read(join(dir, "sys.log")).includes("restart bb-server"))).toBe(true);
    const calls = read(join(dir, "sys.log"));
    expect(calls).not.toMatch(/stop --no-block|kill -s/); // nothing to escalate: no stop of ours runs before or after
    expect(read(join(dir, "sleep.log")).split("\n")[0]).toBe("10"); // main's ten seconds before the first look
    rmSync(join(dir, "s"), { force: true });
    const down = run(["restart"], { ...base, ...silentDoor });
    expect(down.status).toBe(1);
    expect(down.stdout.trim().split("\n").pop()).toBe("down: the door did not answer in 30s");
    // live work read holds the restart, and nothing is restarted
    execFileSync("sqlite3", [db, "insert into lane_pilot_attempt values('att1','task1','running','thr1');"]);
    rmSync(join(dir, "sys.log"), { force: true });
    const refused = run(["restart"], { ...base, CURL_AFTER: "0" });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain("att1 task1 thr1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(read(join(dir, "sys.log"))).not.toContain("restart bb-server");
    // an unreadable database does not hold it
    const unknown = run(["restart"], { ...base, CURL_AFTER: "0", LP_WATCH_LP_DB: join(dir, "missing.db") });
    expect(unknown.stdout).toContain("unknown live work");
    expect(unknown.status).toBe(0);
    expect(await until(() => read(join(dir, "sys.log")).includes("restart bb-server"))).toBe(true);
  }, 30000);

  it("[sma:m_ctl_lift_cmd] lift_cmd picks the platform command: launchctl on darwin, sudo systemctl with sudo, systemctl --user without", () => {
    const { dir, env } = tmp();
    stub(dir, "sudo", "exit 0");
    stub(dir, "sudo-no", "exit 1");
    expect(functions("lift_cmd", { ...env, LP_WATCH_PLATFORM: "darwin", LP_WATCH_SERVICE: "svc" }).trim()).toMatch(/^launchctl kickstart -k gui\/\d+\/svc$/);
    expect(functions("lift_cmd", { ...env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }).trim()).toBe("sudo -n systemctl restart bb-server");
    expect(functions("lift_cmd", { ...env, LP_WATCH_USER: "1" }).trim()).toBe("systemctl --user restart bb-server");
  });

  it("[sma:m_sum_repeat] after a failed owner-push send the next try waits at least five minutes", () => {
    const { dir } = tmp();
    mkdirSync(join(dir, ".config/lp-metrics"), { recursive: true });
    writeFileSync(join(dir, ".config/lp-metrics/tg.env"), "TG_TOKEN=t\nTG_CHAT=1\nTG_TOPIC=2\n");
    stub(dir, "bb", "echo '{\"result\":{\"send\":true,\"text\":\"hi\",\"keys\":[\"k1\"]}}'");
    stub(dir, "curl", 'echo "curl $*" >> "$CURL_LOG"; [ -f "$CURL_OK" ] && exit 0 || exit 22');
    const failedAt = join(dir, ".lane-pilot/owner-push.failed-at");
    mkdirSync(join(dir, ".lane-pilot"));
    const env = { ...process.env, HOME: dir, PATH: `${join(dir, "bin")}:${process.env.PATH}`, LP_PUSH_FAILED_AT: failedAt, CURL_LOG: join(dir, "curl.log") };
    const push = (extra: Record<string, string> = {}) => spawnSync("bash", [pushScript], { env: { ...env, ...extra }, encoding: "utf8" });
    const first = push();
    expect(first.status).toBe(1);
    expect(existsSync(failedAt)).toBe(true);
    const second = push();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("waiting after a failed send");
    expect(readFileSync(join(dir, "curl.log"), "utf8").match(/sendMessage/g)).toHaveLength(1);
    writeFileSync(failedAt, String(Math.floor(Date.now() / 1000) - 400));
    writeFileSync(join(dir, "ok"), "");
    const third = push({ CURL_OK: join(dir, "ok") });
    expect(third.status).toBe(0);
    expect(readFileSync(join(dir, "curl.log"), "utf8").match(/sendMessage/g)).toHaveLength(2);
    expect(existsSync(failedAt)).toBe(false);
  });

  it("[sma:m_sd_outage] messages go to LP_WATCH_TG_API, not telegram.org; the outage_live drill refuses a service that is not its stand-in unit", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const envFile = join(dir, "tg.env");
    writeFileSync(envFile, "TG_TOKEN=t\nTG_CHAT=1\n");
    const out = functions(`say "hello"`, { ...env, LP_WATCH_TG_ENV: envFile, LP_WATCH_TG_API: "http://127.0.0.1:44999", CURL_STATE: join(dir, "s"), TG_LOG: join(dir, "tg.log") });
    expect(out).not.toContain("api.telegram.org");
    expect(readFileSync(join(dir, "tg.log"), "utf8")).toContain("127.0.0.1:44999/bott/sendMessage");
    const refused = spawnSync("python3", ["-c", `import importlib.machinery, os, pathlib, sys
os.environ["LP_WATCH_SERVICE"] = "bb-server"
m = importlib.machinery.SourceFileLoader("drill", ${JSON.stringify(drillPy)}).load_module()
row = m.scenario_outage_live(pathlib.Path(${JSON.stringify(dir)}))
print(row["result"], row.get("note", ""))`], { encoding: "utf8" });
    expect(refused.stdout).toContain("skipped");
    expect(refused.stdout).toContain("lp-drill-door");
  });

  it("[sma:m_sp_watch_loop] the loop waits LP_WATCH_FIRST_SEC before the first look and the generated units cap a fallen watchdog at five restarts an hour", async () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const e = { ...process.env, ...env, ...silentDoor, LP_WATCH_DRY: "1", CURL_STATE: join(dir, "s"), LP_WATCH_FIRST_SEC: "3", LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: "2" };
    const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 1800)); // inside the first-look delay
    const log = join(dir, "outages.jsonl");
    expect(readFileSync(log, "utf8")).toContain('"event":"start"');
    expect(readFileSync(log, "utf8")).not.toContain('"event":"outage"');
    await new Promise((resolve) => setTimeout(resolve, 5000)); // after the delay it knocks and declares
    expect(readFileSync(log, "utf8")).toContain('"event":"outage"');
    proc.kill("SIGTERM");
    for (const which of ["system", "user"]) {
      // the default unit carries the five-restarts cap and the two-minute first look; LP_WATCH_RESTART_CAP=0/empty turns the cap off
      const out = run(["print-unit", which], env);
      expect(out.stdout).toContain("StartLimitBurst=5");
      expect(out.stdout).toContain("StartLimitIntervalSec=3600");
      expect(out.stdout).toContain("Environment=LP_WATCH_FIRST_SEC=120");
      expect(run(["print-unit", which], { ...env, LP_WATCH_RESTART_CAP: "0" }).stdout).not.toContain("StartLimit");
      const capped = run(["print-unit", which], { ...env, LP_WATCH_RESTART_CAP: "9" });
      expect(capped.stdout).toContain("StartLimitBurst=9");
    }
  }, 20000);

  it("[sma:m_sp_watch_xml] print-unit system, user and mac state the two-minute delay and the restart cap, and register nothing", () => {
    const { dir, env } = tmp();
    for (const which of ["system", "user"]) {
      const out = run(["print-unit", which], env);
      expect(out.stdout).toContain("Environment=LP_WATCH_FIRST_SEC=120");
      expect(out.stdout).toContain("StartLimitBurst=5");
    }
    const mac = run(["print-unit", "mac"], env);
    expect(mac.stdout).toContain("ThrottleInterval");
    expect(mac.stdout).toContain("<key>LP_WATCH_FIRST_SEC</key><string>120</string>");
    expect(readdirSync(dir).filter((f) => f !== "bin")).toEqual([]);
  });

  it("[sma:m_sp_watch_plist] on a Mac the watchdog lifts a hung server through launchctl, tells the person between death and relift, and the mkdir lock keeps it single", async () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    stub(dir, "launchctl", `echo "$*" >> "$LCTL_LOG"
case "$*" in
  print*) printf '  pid = %s\\n  state = running\\n' "$(cat "$MAINPID_FILE")" ;;
  kickstart*) echo 5151 > "$MAINPID_FILE"; touch "$KICKED" ;;
esac
exit 0`);
    stub(dir, "uname", "echo Darwin");
    writeFileSync(join(dir, "mainpid"), "4242\n");
    writeFileSync(join(dir, "down"), "");
    const e = { ...process.env, ...env, LP_WATCH_PLATFORM: "darwin", CURL_AFTER: "999999", CURL_CODE: "000", CURL_RC: "28", CURL_STATE: join(dir, "s"), TG_LOG: join(dir, "tg.log"), LCTL_LOG: join(dir, "lctl.log"), LCTL_STATE: join(dir, "lctl"), MAINPID_FILE: join(dir, "mainpid"), KICKED: join(dir, "kicked"), LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" };
    // the door opens once launchctl kickstart ran
    stub(dir, "curl-live", "unused");
    writeFileSync(join(dir, "bin", "curl"), `#!/bin/sh
for a in "$@"; do case "$a" in *sendMessage*) echo "$@" >> "$TG_LOG"; exit 0;; esac; done
[ -f "$KICKED" ] && { echo 200; exit 0; }
echo 000; exit 28`);
    chmodSync(join(dir, "bin", "curl"), 0o755);
    const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 14000));
    proc.kill("SIGTERM");
    const log = readFileSync(join(dir, "outages.jsonl"), "utf8");
    expect(log).toContain('"event":"outage"');
    expect(log).toContain('"event":"lift"');
    expect(log).toContain('"event":"risen"');
    const lctl = readFileSync(join(dir, "lctl.log"), "utf8");
    expect(lctl).toContain("kill SIGKILL");
    expect(lctl).toContain("kickstart -k");
    // the mkdir lock where flock is missing: a second watchdog finds it and leaves
    const restricted = pathWithout("flock");
    const first = spawn("bash", [script, "run"], { env: { ...e, PATH: `${join(dir, "bin")}:${restricted}` }, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = spawnSync("bash", [script, "run"], { env: { ...e, PATH: `${join(dir, "bin")}:${restricted}`, LP_WATCH_LOCK_HELD_SEC: "0" }, encoding: "utf8" });
    first.kill("SIGTERM");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("another watchdog runs");
  }, 30000);

  it("[sma:m_sp_watch_lock] a second watchdog that finds the lock waits 60 s before it leaves, so the unit's five-restarts cap is not spent on it; a dry run does not wait", async () => {
    const { dir, env } = tmp();
    stub(dir, "sleep", SLEEP_STUB);
    stub(dir, "curl", CURL_STUB); // nothing real can be reached if the lock were ever free: the manager is a stub too
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const holderOfLock = spawn("flock", ["-n", join(dir, "hub-watchdog.lock"), "/bin/sleep", "20"], { stdio: "ignore" });
    try {
      expect(await until(() => existsSync(join(dir, "hub-watchdog.lock")))).toBe(true);
      const e = { ...env, SLEEP_LOG: join(dir, "sleep.log"), LP_WATCH_DOOR: "http://127.0.0.1:1/no", LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, SYS_LOG: join(dir, "sys.log"), CURL_STATE: join(dir, "s"), TG_LOG: join(dir, "tg.log") };
      const second = run(["run"], e);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("another watchdog runs");
      expect(read(join(dir, "sleep.log")).trim().split("\n")).toEqual(["60"]);
      rmSync(join(dir, "sleep.log"));
      run(["run"], { ...e, LP_WATCH_DRY: "1" });
      expect(read(join(dir, "sleep.log"))).toBe("");
    } finally {
      holderOfLock.kill("SIGKILL");
    }
  }, 20000);
});
