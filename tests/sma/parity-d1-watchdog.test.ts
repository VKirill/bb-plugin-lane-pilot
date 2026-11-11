import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/hub-watchdog.sh");
const pushScript = join(process.cwd(), "scripts/lp-owner-push.sh");
const drillPy = join(process.cwd(), "scripts/lp-drill.py");

function run(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const done = spawnSync("bash", [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: done.status ?? 1, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
}

/** The script's case statement would run on source; the functions above it are the behaviour. */
function functions(body: string, env: Record<string, string>): string {
  const source = `sed '/^case /,$d' ${JSON.stringify(script)}`;
  return execFileSync("bash", ["-c", `source <(${source})\n${body}`], { env: { ...process.env, ...env }, encoding: "utf8" });
}

function stub(dir: string, name: string, text: string): string {
  const path = join(dir, "bin", name);
  writeFileSync(path, `#!/bin/sh\n${text}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** curl stub: a POST to .../sendMessage is logged to $TG_LOG and returns $TG_RC; anything else prints the http_code. */
const CURL_STUB = `for a in "$@"; do
  case "$a" in *sendMessage*) echo "$@" >> "$TG_LOG"; exit "\${TG_RC:-0}" ;; esac
done
n=0; [ -f "$CURL_STATE" ] && n="$(cat "$CURL_STATE")"
echo $((n + 1)) > "$CURL_STATE"
if [ "$n" -ge "\${CURL_AFTER:-999999}" ]; then echo 200; exit 0; fi
echo "\${CURL_CODE:-000}"; exit "\${CURL_RC:-0}"`;

const SYSTEMCTL_STUB = `echo "$*" >> "$SYS_LOG"
case "$*" in
  *"show -p MainPID"*) cat "$MAINPID_FILE" 2>/dev/null || echo 4242 ;;
  *"show -p ActiveState"*) cat "$STATE_FILE" 2>/dev/null || echo inactive ;;
  *"show -p Result"*) echo failure; echo 1 ;;
  *"show -p ControlGroup"*) echo "$UNIT_CG" ;;
  *"show -p TimeoutStopUSec"*) echo "$TIMEOUT_STOP" ;;
  *show-environment*) exit "\${USERCTL_RC:-0}" ;;
  *restart*) [ -n "\${RESTART_ERR:-}" ] && echo "$RESTART_ERR" >&2; [ -n "\${MAINPID_AFTER:-}" ] && echo "$MAINPID_AFTER" > "$MAINPID_FILE"; exit "\${RESTART_RC:-0}" ;;
esac
exit 0`;

const SS_STUB = `cat "$SS_OUT" 2>/dev/null`;

/** sleep stub: logs its argument and returns at once, so a wait of minutes is read from the log, not waited out. */
const SLEEP_STUB = `echo "$1" >> "$SLEEP_LOG"`;

/** A process the test starts itself, to stand for the port holder; the watchdog may only signal it under its rules. */
function holder(): { pid: number; alive: () => boolean; stop: () => void; cgroup: () => string } {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  const pid = child.pid!;
  const alive = () => { try { process.kill(pid, 0); return !readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2].startsWith("Z"); } catch { return false; } };
  const cgroup = () => { try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n")[0].replace(/^[^:]*:[^:]*:/, ""); } catch { return ""; } };
  holders.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  return { pid, alive, stop: () => child.kill("SIGKILL"), cgroup };
}
const holders: Array<() => void> = [];

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return check();
}
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A stub bin dir with everything from /usr/bin and /bin except the named tools (to fake a missing prerequisite). */
function pathWithout(...missing: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-path-"));
  mkdirSync(join(dir, "bin"));
  for (const src of ["/usr/bin", "/bin"]) {
    for (const tool of readdirSync(src)) {
      const target = join(dir, "bin", tool);
      if (!existsSync(target)) {
        try { symlinkSync(join(src, tool), target); } catch { /* duplicate names */ }
      }
    }
  }
  for (const tool of missing) rmSync(join(dir, "bin", tool), { force: true });
  return join(dir, "bin");
}

const dirs: string[] = [];
function tmp(): { dir: string; bin: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "lp-sma-d1-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  const env: Record<string, string> = {
    LP_WATCH_STATE: dir,
    LP_WATCH_TG_ENV: join(dir, "no-telegram"),
    LP_WATCH_BB: join(dir, "bin", "bb-missing"),
    LP_WATCH_FIRST_SEC: "0",
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
  };
  return { dir, bin: join(dir, "bin"), env };
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); while (holders.length) holders.pop()!(); });

const silentDoor = { CURL_AFTER: "999999", CURL_CODE: "000", CURL_RC: "28" };

describe("hub watchdog parity D1", () => {
  it("[sma:m_ctl_probe] the HTTP 200 alone says the hub answers: a board request that fails, is noisy or hangs is advisory, never an outage, a lift or a failed status", async () => {
    const variants: Record<string, string> = {
      "bb exits 127 (no node on the PATH)": "echo 'env: node: No such file or directory' >&2; exit 127",
      "bb prints noise on stderr and a reply that is no array": "echo 'warn: something' >&2; echo '{\"threads\":[]}'",
      "bb times out": "exit 0",
    };
    for (const [name, text] of Object.entries(variants)) {
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
    }
    // the clean results still count: a signed-out CLI says auth, a bare array says ok
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const base = { ...env, CURL_AFTER: "0" };
    expect(functions("board_probe", { ...base, LP_WATCH_BB: stub(dir, "bb-auth", "echo 'error: not signed in (run bb auth login)'; exit 1") }).trim()).toBe("auth");
    expect(functions("board_probe", { ...base, LP_WATCH_BB: stub(dir, "bb-ok", "echo '[]'") }).trim()).toBe("ok");
    expect(functions("board_probe", env).trim()).toBe("none");
  }, 60000);

  it("[sma:m_ctl_probe] the run loop makes the board request on every 20th knock when LP_WATCH_BOARD_EVERY is unset; 0 never; it stays advisory", async () => {
    expect(functions('echo "$BOARD_EVERY $KILL_HOLDER"', tmp().env).trim()).toBe("20 1");
    expect(functions('echo "$BOARD_EVERY"', { ...tmp().env, LP_WATCH_BOARD_EVERY: "0" }).trim()).toBe("0");
    const count = async (more: Record<string, string>) => {
      const { dir, env } = tmp();
      stub(dir, "curl", CURL_STUB);
      stub(dir, "sleep", SLEEP_STUB);
      const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
      const bb = stub(dir, "bb", 'echo x >> "$BB_LOG"; echo "[]"');
      writeFileSync(join(dir, "mainpid"), "4242\n");
      writeFileSync(join(dir, "state"), "active\n");
      const e = { ...process.env, ...env, CURL_AFTER: "0", CURL_STATE: join(dir, "s"), SLEEP_LOG: join(dir, "sleep.log"), BB_LOG: join(dir, "bb.log"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_BB: bb, ...more };
      const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
      await until(() => Number(read(join(dir, "s")).trim() || 0) >= 45, 20000);
      proc.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const knocks = Number(read(join(dir, "s")).trim() || 0);
      const log = read(join(dir, "outages.jsonl"));
      expect(log).not.toContain('"event":"outage"');
      expect(log).not.toContain('"event":"lift"');
      return { knocks, calls: read(join(dir, "bb.log")).split("\n").filter(Boolean).length };
    };
    const unset = await count({});
    expect(unset.knocks).toBeGreaterThanOrEqual(45);
    expect(unset.calls).toBeGreaterThanOrEqual(Math.floor(unset.knocks / 20) - 1);
    expect(unset.calls).toBeLessThanOrEqual(Math.floor(unset.knocks / 20) + 1);
    expect(unset.calls).toBeGreaterThanOrEqual(1);
    const never = await count({ LP_WATCH_BOARD_EVERY: "0" });
    expect(never.calls).toBe(0);
  }, 60000);

  it("[sma:m_ctl_unnamed] the door answers but the port holder is proven outside the unit's cgroup: status, stop, restart and lift say 'process unproven' and run no kill; --force goes on; a holder that cannot be read is only 'unknown'", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "ss", SS_STUB);
    const other = holder();
    writeFileSync(join(dir, "ss.out"), `LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=${other.pid},fd=1))\n`);
    writeFileSync(join(dir, "mainpid"), "4242\n");
    writeFileSync(join(dir, "state"), "active\n");
    const db = join(dir, "data.db");
    execFileSync("sqlite3", [db, "create table lane_pilot_attempt(id,task_id,state,thread_id);"]);
    const e = { ...env, CURL_AFTER: "0", SS_OUT: join(dir, "ss.out"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db, UNIT_CG: "/lp-test.slice/bb-server.service", LP_WATCH_STOP_SEC: "1" };
    const status = run(["status"], e);
    expect(status.status).toBe(2);
    expect(status.stdout).toContain(`door answers, process unproven: port 38886 is held by pid ${other.pid}, outside bb-server (pid 4242); nothing was touched`);
    for (const verb of ["stop", "restart", "lift"]) {
      const out = run([verb], e);
      expect(out.status).toBe(2);
      expect(out.stdout).toContain("door answers, process unproven");
    }
    expect(read(join(dir, "sys.log"))).not.toMatch(/stop --no-block|kill -s|restart bb-server/);
    expect(other.alive()).toBe(true);
    // --force overrides the refusal
    const forced = run(["stop", "--force"], e);
    expect(forced.stdout).toContain("--force given, going on");
    expect(read(join(dir, "sys.log"))).toContain("stop --no-block bb-server");
    // a holder inside the unit's cgroup is ours
    const inside = run(["status"], { ...e, UNIT_CG: other.cgroup() });
    expect(inside.status).toBe(0);
    expect(inside.stdout).not.toContain("unproven");
    // unreadable is unknown: printed, never a refusal (no cgroup of the unit; a pid that is not there; a listener without a pid)
    for (const [why, ssText, unitCg] of [["unit cgroup unreadable", `LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=${other.pid},fd=1))\n`, ""], ["pid not there", 'LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=4999999,fd=1))\n', "/lp-test.slice/bb-server.service"], ["listener without a pid", "LISTEN 0 1 127.0.0.1:38886 0.0.0.0:*\n", "/lp-test.slice/bb-server.service"]]) {
      writeFileSync(join(dir, "ss.out"), ssText);
      const unknown = run(["status"], { ...e, UNIT_CG: unitCg });
      expect(unknown.status, why).toBe(0);
      expect(unknown.stdout, why).toContain("unknown: the holder of port 38886");
      expect(unknown.stdout, why).not.toContain("unproven");
      expect(run(["lift"], { ...e, UNIT_CG: unitCg }).stdout, why).toContain("nothing to do: the door answers");
    }
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

  it("[sma:m_ctl_killed] a stop the process does not obey is escalated to a kill and said to have been hard, after the unit's own TimeoutStopUSec (90 s when unreadable)", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    stub(dir, "sleep", SLEEP_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const db = join(dir, "data.db");
    execFileSync("sqlite3", [db, "create table lane_pilot_attempt(id,task_id,state,thread_id);"]);
    writeFileSync(join(dir, "state"), "active\n");
    const e = { ...env, ...silentDoor, SYS_LOG: join(dir, "sys.log"), SLEEP_LOG: join(dir, "sleep.log"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db };
    const waited = () => read(join(dir, "sleep.log")).split("\n").filter((l) => l === "1").length;
    for (const [timeout, seconds] of [["1min 30s", 90], ["45s", 45], ["", 90], ["infinity", 90], ["2min", 120]] as const) {
      rmSync(join(dir, "sleep.log"), { force: true });
      const hard = run(["stop"], { ...e, TIMEOUT_STOP: timeout });
      expect(hard.status, timeout).toBe(0);
      expect(hard.stdout, timeout).toContain(`stopped hard: the process did not leave in ${seconds}s and was killed`);
      expect(waited(), timeout).toBe(seconds);
    }
    expect(read(join(dir, "sys.log"))).toContain("kill -s SIGKILL bb-server");
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toContain('"event":"stopped_hard"');
    // a setting still wins over the unit
    rmSync(join(dir, "sleep.log"), { force: true });
    expect(run(["stop"], { ...e, TIMEOUT_STOP: "5min", LP_WATCH_STOP_SEC: "3" }).stdout).toContain("did not leave in 3s");
    writeFileSync(join(dir, "state"), "inactive\n");
    expect(run(["stop"], e).stdout).toContain("stopped:");
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

  it("[sma:m_ctl_exit] exit 2 is a refusal a flag would lift; status 'unknown' is exit 1 and names the flag", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", `echo "$*" >> "$SYS_LOG"`); // answers nothing: the manager cannot be asked
    const e = { ...env, ...silentDoor, SYS_LOG: join(dir, "sys.log"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys };
    const status = run(["status"], e);
    expect(status.status).toBe(1);
    expect(status.stdout).toContain("unknown:");
    // the five-lifts-in-an-hour refusal: exit 2 and the flag named, and --force lifts it
    functions(`for n in 1 2 3 4 5; do record lift "seed $n"; done`, { ...env, LP_WATCH_DRY: "1" });
    const refused = run(["lift"], { ...e, LP_WATCH_DRY: "1" });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain("--force");
    const forced = run(["lift", "--force"], { ...e, LP_WATCH_DRY: "1" });
    expect(forced.status).toBe(1);
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toContain("dry: would kill");
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

  it("[sma:m_w_back] the same process answering again closes the outage as a false alarm; another process speaks as risen", async () => {
    const runOutage = async (mainAfter: string) => {
      const { dir, env } = tmp();
      stub(dir, "curl", CURL_STUB);
      const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
      writeFileSync(join(dir, "mainpid"), "4242\n");
      writeFileSync(join(dir, "state"), "active\n");
      const tgEnv = join(dir, "tg.env");
      writeFileSync(tgEnv, "TG_TOKEN=t\nTG_CHAT=1\n");
      const e = { ...process.env, ...env, CURL_AFTER: "3", CURL_STATE: join(dir, "curl.state"), LP_WATCH_TG_ENV: tgEnv, TG_LOG: join(dir, "tg.log"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), MAINPID_AFTER: mainAfter, LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" };
      const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 13000));
      proc.kill("SIGTERM");
      return {
        log: readFileSync(join(dir, "outages.jsonl"), "utf8"),
        tg: existsSync(join(dir, "tg.log")) ? readFileSync(join(dir, "tg.log"), "utf8") : "",
      };
    };
    const same = await runOutage("4242");
    expect(same.log).toContain('"event":"false_alarm"');
    expect(same.log).not.toContain('"event":"risen"');
    expect(same.tg).toContain("тревога была ложной");
    const other = await runOutage("5151");
    expect(other.log).toContain('"event":"risen"');
    expect(other.tg).toContain("поднялся");
  }, 30000);

  it("[sma:m_w_suspect] eight silent knocks in a row of any kind declare an outage, seven do not; refused ones declare at three once the door has answered 200, another count only by setting", async () => {
    const outageWithin = async (extra: Record<string, string>, seconds: number, curl = CURL_STUB) => {
      const { dir, env } = tmp();
      stub(dir, "curl", curl);
      const e = { ...process.env, ...env, LP_WATCH_DRY: "1", CURL_STATE: join(dir, "s"), LP_WATCH_KNOCK_SEC: "1", ...extra };
      const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      proc.kill("SIGTERM");
      return read(join(dir, "outages.jsonl"));
    };
    expect(functions('echo "$REFUSED_AFTER $SUSPECT_AFTER $FIRST_SEC"', tmp().env).trim()).toBe("3 8 0");
    // seven refused knocks, then the door answers: no outage (a count of three would have declared it)
    const seven = await outageWithin({ CURL_AFTER: "7", CURL_RC: "7" }, 11);
    expect(seven).not.toContain('"event":"outage"');
    // refused for good: declared at the eighth, not before
    const early = await outageWithin({ CURL_AFTER: "999999", CURL_RC: "7" }, 5);
    expect(early).not.toContain('"event":"outage"');
    const eight = await outageWithin({ CURL_AFTER: "999999", CURL_RC: "7" }, 11);
    expect(eight).toContain('"event":"outage"');
    expect(eight).toContain("refused");
    // refused knocks declare at three, but only once the door has answered 200 (the seen-200 marker): before it the eight-knock rule stands
    const seenThenRefused = `n=0; [ -f "$CURL_STATE" ] && n=$(cat "$CURL_STATE"); echo $((n+1)) > "$CURL_STATE"; if [ "$n" -lt 1 ]; then echo 200; exit 0; fi; echo 000; exit 7`;
    const fast = await outageWithin({}, 6, seenThenRefused);
    expect(fast).toContain('"event":"outage"');
    // a longer count is a setting
    const short = await outageWithin({ LP_WATCH_REFUSED_AFTER: "2" }, 5, seenThenRefused);
    expect(short).toContain('"event":"outage"');
    // eight timeouts
    const timeouts = await outageWithin({ CURL_AFTER: "999999", CURL_RC: "28" }, 11);
    expect(timeouts).toContain('"event":"outage"');
    expect(timeouts).toContain("timeout");
    // main counts a mixed row as silence too: refused and timeouts together reach eight
    const mixedCurl = `seq="$(cat "$CURL_SEQ")"; n=0; [ -f "$CURL_STATE" ] && n=$(cat "$CURL_STATE"); echo $((n+1)) > "$CURL_STATE"; code=$(echo "$seq" | cut -d' ' -f$((n+1))); echo 000; exit "\${code:-0}"`;
    const { dir: seqDir } = tmp();
    writeFileSync(join(seqDir, "seq"), "7 7 28 7 7 28 7 7 28 7 7");
    const mixed = await outageWithin({ CURL_SEQ: join(seqDir, "seq"), LP_WATCH_REFUSED_AFTER: "5" }, 11, mixedCurl);
    expect(mixed).toContain('"event":"outage"');
  }, 90000);

  it("[sma:m_w_backoff] after each restart the lift sleeps the whole wait main sleeps (30, 60, 120 s); the log only picks which wait", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    stub(dir, "sleep", SLEEP_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    writeFileSync(join(dir, "mainpid"), "4242\n");
    const e = { ...env, ...silentDoor, CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), SLEEP_LOG: join(dir, "sleep.log"), MAINPID_FILE: join(dir, "mainpid"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys };
    const fives = () => read(join(dir, "sleep.log")).split("\n").filter((l) => l === "5").length;
    // a fresh outage: try 1 waits 30 s, try 2 waits 60 s, try 3 waits 120 s — whatever time passed between the tries
    functions("lift || true", { ...e, LP_WATCH_MAX_LIFTS: "3" });
    const log = readFileSync(join(dir, "outages.jsonl"), "utf8");
    expect(log).toContain("try 1, waited 30s");
    expect(log).toContain("try 2, waited 60s");
    expect(log).toContain("try 3, waited 120s");
    expect(fives()).toBe((30 + 60 + 120) / 5);
    // a lift the log already holds (40 s ago) is not subtracted from the next wait: the whole 60 s
    rmSync(join(dir, "sleep.log"), { force: true });
    rmSync(join(dir, "outages.jsonl"));
    writeFileSync(join(dir, "outages.jsonl"), `{"at":${Math.floor(Date.now() / 1000) - 40},"event":"lift","detail":"a"}\n`);
    functions("lift || true", { ...e, LP_WATCH_MAX_LIFTS: "1" });
    expect(fives()).toBe(60 / 5);
    // a risen outage in the log starts over at 30 s
    rmSync(join(dir, "sleep.log"), { force: true });
    functions('record risen x; lift || true', { ...e, LP_WATCH_MAX_LIFTS: "1" });
    expect(fives()).toBe(30 / 5);
  }, 30000);

  it("[sma:m_w_lifting] a repeated lift kills a port holder only when the MainPID was read and is not 0 and the holder is proven outside the unit's cgroup; never a holder inside it, never pid 1, the watchdog or its parent; unset kills, LP_WATCH_KILL_HOLDER=0 only names", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    stub(dir, "sleep", SLEEP_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "ss", SS_STUB);
    const lift = (mainpid: string, ssPids: number[], unitCg: string, more: Record<string, string> = {}) => {
      rmSync(join(dir, "outages.jsonl"), { force: true });
      writeFileSync(join(dir, "mainpid"), `${mainpid}\n`);
      writeFileSync(join(dir, "ss.out"), ssPids.map((pid) => `LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=${pid},fd=1))`).join("\n") + "\n");
      functions("lift || true", { ...env, ...silentDoor, CURL_STATE: join(dir, "s"), SS_OUT: join(dir, "ss.out"), SYS_LOG: join(dir, "sys.log"), SLEEP_LOG: join(dir, "sleep.log"), MAINPID_FILE: join(dir, "mainpid"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_MAX_LIFTS: "2", UNIT_CG: unitCg, ...more });
      return read(join(dir, "outages.jsonl"));
    };
    const stranger = holder();
    const elsewhere = "/lp-test.slice/bb-server.service";
    // MainPID 0 (the usual state right after the kill) or unreadable: nothing is killed
    expect(lift("0", [stranger.pid], elsewhere)).not.toContain("port_holder_killed");
    expect(stranger.alive()).toBe(true);
    expect(lift("", [stranger.pid], elsewhere)).not.toContain("port_holder_killed");
    expect(stranger.alive()).toBe(true);
    // the unit's cgroup cannot be read, or the holder is inside it: nothing is killed
    expect(lift("4242", [stranger.pid], "")).not.toContain("port_holder_killed");
    expect(lift("4242", [stranger.pid], stranger.cgroup())).not.toContain("port_holder_killed");
    expect(stranger.alive()).toBe(true);
    // pid 1 and the watchdog's own parent are never signalled (they are outside the stand-in cgroup too)
    expect(lift("4242", [1, process.pid], elsewhere)).not.toContain("port_holder_killed");
    // LP_WATCH_KILL_HOLDER=0 (the old way): a holder proven outside is named in the record and left alone
    const named = lift("4242", [stranger.pid], elsewhere, { LP_WATCH_KILL_HOLDER: "0" });
    expect(named).toContain(`"event":"port_holder_seen"`);
    expect(named).toContain(`held by pid ${stranger.pid}`);
    expect(named).not.toContain("port_holder_killed");
    expect(stranger.alive()).toBe(true);
    // nothing set (default 1), read MainPID, holder proven outside: killed on try 2 only, and recorded
    const log = lift("4242", [stranger.pid], elsewhere);
    expect(log).toContain(`killing port holder ${stranger.pid}`);
    expect(log.match(/port_holder_killed/g)).toHaveLength(1);
    expect(stranger.alive()).toBe(false);
  }, 60000);

  it("[sma:m_out_marker] [sma:m_out_lift_failed] an outage record holds the first silence, the declaration, the messages and every lift attempt with its time; `outages` prints the block and `daily` counts it", async () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    writeFileSync(join(dir, "mainpid"), "4242\n");
    writeFileSync(join(dir, "state"), "active\n");
    const envFile = join(dir, "tg.env");
    writeFileSync(envFile, "TG_TOKEN=t\nTG_CHAT=1\n");
    writeFileSync(join(dir, "hub-watchdog.out-tries-said"), ""); // left by an earlier outage (a watchdog restarted mid-outage): a new outage must still say «lift failed»
    stub(dir, "sleep", 'exec /bin/sleep "$(awk "BEGIN{print $1 / 10}")"'); // ten times faster, so the 30 s wait is read in three
    const e = { ...process.env, ...env, ...silentDoor, LP_WATCH_TG_ENV: envFile, CURL_STATE: join(dir, "s"), TG_LOG: join(dir, "tg.log"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1", RESTART_ERR: "Job failed. See journalctl", RESTART_RC: "1" };
    const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 9000));
    proc.kill("SIGTERM");
    const rows = readFileSync(join(dir, "outages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const events = rows.map((r) => r.event);
    const tail = events.slice(events.indexOf("first_silence")); // the 'start' line comes first
    expect(tail.slice(0, 3)).toEqual(["first_silence", "outage", "message_sent"]);
    expect(tail).toContain("lift_without_outcome");
    const outIdx = tail.indexOf("out_of_tries");
    expect(outIdx).toBeGreaterThan(-1);
    expect(tail[outIdx + 1]).toBe("message_sent"); // the «lift failed» word
    const silence = rows.find((r) => r.event === "first_silence")!;
    const outage = rows.find((r) => r.event === "outage")!;
    expect(silence.at).toBeLessThanOrEqual(outage.at);
    expect(outage.at - silence.at).toBeGreaterThanOrEqual(2);
    expect(outage.detail).toContain("timeout");
    expect(rows.find((r) => r.event === "out_of_tries")!.detail).toContain("Job failed. See journalctl");
    expect(rows.filter((r) => r.event === "message_sent").map((r) => r.detail).join("\n")).toContain("Причина: Job failed. See journalctl");
    expect(existsSync(join(dir, "hub-watchdog.out-tries-said"))).toBe(true);
    const block = run(["outages"], env);
    expect(block.status).toBe(0);
    expect(block.stdout).toContain("first_silence");
    expect(block.stdout).toContain("out_of_tries");
    const daily = run(["daily"], env);
    expect(daily.stdout).toMatch(/\d{4}-\d{2}-\d{2} out_of_tries 1/);
  }, 30000);

  it("[sma:m_out_notify] a send that cannot happen records message_not_sent with the named reason; a good send records message_sent", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const log = () => (existsSync(join(dir, "outages.jsonl")) ? readFileSync(join(dir, "outages.jsonl"), "utf8") : "");
    functions(`say "hello" || true`, { ...env, CURL_STATE: join(dir, "s1"), TG_LOG: join(dir, "tg1") });
    expect(log()).toContain('"event":"message_not_sent"');
    expect(log()).toContain(`no tg.env at ${join(dir, "no-telegram")}`);
    const envFile = join(dir, "tg.env");
    writeFileSync(envFile, "TG_TOKEN=t\n");
    functions(`say "hello" || true`, { ...env, LP_WATCH_TG_ENV: envFile, CURL_STATE: join(dir, "s2"), TG_LOG: join(dir, "tg2") });
    expect(log()).toContain("TG_CHAT empty");
    writeFileSync(envFile, "TG_TOKEN=t\nTG_CHAT=1\n");
    functions(`say "hello" || true`, { ...env, LP_WATCH_TG_ENV: envFile, CURL_STATE: join(dir, "s3"), TG_LOG: join(dir, "tg3"), TG_RC: "22" });
    expect(log()).toContain("telegram refused (curl 22)");
    functions(`say "hello" || true`, { ...env, LP_WATCH_TG_ENV: envFile, CURL_STATE: join(dir, "s4"), TG_LOG: join(dir, "tg4") });
    expect(log()).toContain('"event":"message_sent"');
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

  it("[sma:m_sd_lift] a live lift kills the hung main pid and restarts the service: the log holds the killed pid, lifted-pid the new one, and the door answers", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    writeFileSync(join(dir, "mainpid"), "4242\n");
    const e = { ...env, CURL_AFTER: "2", CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), MAINPID_AFTER: "5151", LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_SERVICE: "lp-drill-door" };
    functions("lift", e);
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toContain('"event":"lift","detail":"try 1, killing pid 4242"');
    expect(readFileSync(join(dir, "hub-watchdog.lifted-pid"), "utf8").trim()).toBe("5151");
    expect(readFileSync(join(dir, "sys.log"), "utf8")).toContain("restart lp-drill-door");
  });

  it("[sma:m_sp_smoke_mac] selfcheck prints one line per prerequisite and verb and exits with the number of failures", () => {
    const { env } = tmp();
    const restricted = pathWithout("sqlite3", "curl");
    const out = run(["selfcheck"], { ...env, PATH: restricted });
    expect(out.status).toBe(2);
    expect(out.stdout).toContain("FAIL: prerequisite: curl");
    expect(out.stdout).toContain("FAIL: prerequisite: sqlite3");
    expect(out.stdout).toContain("ok: prerequisite: bash");
    expect(out.stdout).toContain("verb: status");
  }, 30000);

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

  it("[sma:m_sp_install_watch] without administrator rights the install says the refusal in words before the fallback", () => {
    const { dir, env } = tmp();
    stub(dir, "sudo", "exit 1");
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "crontab", `cat >> "$CRON_LOG"`);
    writeFileSync(join(dir, "state"), "active\n");
    const e = { ...env, HOME: dir, SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "m"), STATE_FILE: join(dir, "state"), CRON_LOG: join(dir, "cron.log"), LP_WATCH_SYSTEMCTL: sys };
    const user = run(["install"], { ...e, LP_WATCH_RESTART_CAP: "5" });
    expect(user.stdout.indexOf("no administrator rights (sudo -n refused)")).toBeLessThan(user.stdout.indexOf("installed: user unit"));
    expect(readFileSync(join(dir, ".config/systemd/user/lp-hub-watchdog.service"), "utf8")).toContain("StartLimitBurst=5");
    const cron = run(["install"], { ...e, USERCTL_RC: "1" });
    expect(cron.stdout).toContain("no user systemd here: using an @reboot crontab line");
    expect(readFileSync(join(dir, "cron.log"), "utf8")).toContain("@reboot");
  });

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

  it("[sma:m_tl_crash] a writer process killed with SIGKILL mid-loop leaves a database db-ready calls ready, with no rows lost", () => {
    const { dir, env } = tmp();
    const db = join(dir, "stand.db");
    execFileSync("sqlite3", [db, "pragma journal_mode=WAL; create table beats(n integer);"]);
    const writer = spawn("bash", ["-c", `for i in $(seq 1 200000); do sqlite3 ${JSON.stringify(db)} 'insert into beats values (1);' 2>/dev/null; done`], { stdio: "ignore" });
    // The count that passed the wait is the one compared below: a second read beside a busy writer can come back empty
    // (the full run under load saw 0), and the rows only grow, so the earlier figure is a safe floor.
    let before = 0;
    for (let i = 0; i < 60 && before <= 10; i++) {
      execFileSync("sleep", ["0.2"]);
      const count = spawnSync("sqlite3", ["-readonly", db, "select count(*) from beats;"], { encoding: "utf8" });
      before = Number(count.stdout.trim()) || 0;
    }
    expect(before).toBeGreaterThan(10);
    writer.kill("SIGKILL");
    const check = run(["db-ready"], { ...env, LP_WATCH_DBS: db });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(`ready: ${db}`);
    const after = Number(spawnSync("sqlite3", ["-readonly", db, "select count(*) from beats;"], { encoding: "utf8" }).stdout.trim());
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("[sma:m_out_marker] every record line is valid JSON whatever the reason holds: quotes, backslashes, tabs, carriage returns and newlines", () => {
    const { dir, env } = tmp();
    functions(String.raw`record reason "a\b	c"$'\r'"d"$'\n'"e \"q\" \\ end"; record_at 1700000000 first_silence "x\ny"`, env);
    const rows = readFileSync(join(dir, "outages.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0].detail).toContain("a\\b");
    expect(rows[0].detail).toContain("\t");
    expect(rows[0].detail).toContain("\n");
    expect(rows[0].detail).toContain("'q'");
    expect(rows[1].detail).toBe("x\\ny");
  });

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

  it("[sma:m_sd_outage] the full drill and the deploy drill list what they listed on main; outage_live runs only by name, its live pass only with LP_DRILL_WATCHDOG_LIVE=1, and no signal goes to a pid that is not an integer above 1", () => {
    const { dir } = tmp();
    const probe = spawnSync("python3", ["-c", `import importlib.machinery, json, os, pathlib
m = importlib.machinery.SourceFileLoader("drill", ${JSON.stringify(drillPy)}).load_module()
os.environ.pop("LP_DRILL_WATCHDOG_LIVE", None)
row = m.scenario_outage_live(pathlib.Path(${JSON.stringify(dir)}))
print(json.dumps({"all": m.ALL, "quick": m.QUICK, "byName": m.BY_NAME, "row": row["result"], "note": row.get("note", ""), "unlisted": m.scout()["unlisted"], "undefined": m.scout()["undefined"]}))`], { encoding: "utf8" });
    const out = JSON.parse(probe.stdout.trim().split("\n").pop()!);
    const main = execFileSync("git", ["show", "main:scripts/lp-drill.py"], { encoding: "utf8" });
    const mainList = (name: string) => JSON.parse(main.match(new RegExp(`^${name} = (\\[.*\\])$`, "m"))![1]);
    expect(out.all).toEqual(mainList("ALL"));
    expect(out.quick).toEqual(mainList("QUICK"));
    expect(out.byName).toEqual(["outage_live"]);
    expect(out.unlisted).toEqual([]);
    expect(out.undefined).toEqual([]);
    expect(out.row).toBe("skipped");
    expect(out.note).toContain("LP_DRILL_WATCHDOG_LIVE=1");
    // the live pass of the watchdog scenario is off by default
    const src = readFileSync(drillPy, "utf8");
    expect(src).toContain('os.environ.get("LP_DRILL_WATCHDOG_LIVE") == "1"');
    // a stand-in service whose main pid reads 0 is never signalled (0 would be the drill's own process group); run in a session of its own
    const bin = join(dir, "bin");
    stub(dir, "systemctl", 'case "$*" in *"show -p MainPID"*) echo 0 ;; esac; exit 0');
    stub(dir, "curl", "echo 200");
    const guard = spawnSync("setsid", ["-w", "python3", "-c", `import importlib.machinery, pathlib
m = importlib.machinery.SourceFileLoader("drill", ${JSON.stringify(drillPy)}).load_module()
problems, _ = m._watchdog_live(pathlib.Path(${JSON.stringify(dir)}), False, False)
print(problems)`], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` } });
    expect(guard.stdout).toContain("no usable main pid");
    expect(guard.status).toBe(0);
  }, 60000);
});
