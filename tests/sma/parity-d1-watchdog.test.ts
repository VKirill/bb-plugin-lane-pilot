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
  *show-environment*) exit "\${USERCTL_RC:-0}" ;;
  *restart*) [ -n "\${RESTART_ERR:-}" ] && echo "$RESTART_ERR" >&2; [ -n "\${MAINPID_AFTER:-}" ] && echo "$MAINPID_AFTER" > "$MAINPID_FILE"; exit "\${RESTART_RC:-0}" ;;
esac
exit 0`;

const SS_STUB = `cat "$SS_OUT" 2>/dev/null`;

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
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const silentDoor = { CURL_AFTER: "999999", CURL_CODE: "000", CURL_RC: "28" };

describe("hub watchdog parity D1", () => {
  it("[sma:m_ctl_probe] the knock is the window's board request behind the same token: a failing CLI makes it false despite a 200, a CLI that cannot sign in makes it unknown, not silence", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const bbFail = stub(dir, "bb", "exit 1");
    const bbOk = stub(dir, "bb-ok", "echo '[]'");
    const bbAuth = stub(dir, "bb-auth", "echo 'error: not signed in (run `bb auth login`)' >&2; exit 1");
    const base = { ...env, CURL_AFTER: "0" };
    expect(functions("door_answers || echo no", { ...base, LP_WATCH_BB: bbFail })).toContain("no");
    expect(functions("door_answers && echo yes", { ...base, LP_WATCH_BB: bbOk })).toContain("yes");
    expect(functions("door_probe", { ...base, LP_WATCH_BB: bbAuth }).trim()).toBe("unknown");
  });

  it("[sma:m_ctl_unnamed] the door answers but the port holder is not the service's process: status, stop, restart and lift say 'process unproven' and run no kill", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "ss", SS_STUB);
    writeFileSync(join(dir, "ss.out"), 'LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=9999,fd=1))\n');
    writeFileSync(join(dir, "mainpid"), "4242\n");
    writeFileSync(join(dir, "state"), "active\n");
    const e = { ...env, CURL_AFTER: "0", SS_OUT: join(dir, "ss.out"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys };
    const status = run(["status"], e);
    expect(status.status).toBe(1);
    expect(status.stdout).toContain("door answers, process unproven: port 38886 is held by pid 9999, not bb-server pid 4242; nothing was touched");
    for (const verb of ["stop", "restart", "lift"]) {
      const out = run([verb], e);
      expect(out.status).toBe(1);
      expect(out.stdout).toContain("door answers, process unproven");
    }
    const calls = readFileSync(join(dir, "sys.log"), "utf8");
    expect(calls).not.toMatch(/stop --no-block|kill -s|restart bb-server/);
  });

  it("[sma:m_ctl_live_work] a stop refuses while live work runs, listing the workers, until --force is said", () => {
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
    expect(existsSync(join(dir, "sys.log")) ? readFileSync(join(dir, "sys.log"), "utf8") : "").not.toContain("stop --no-block");
    const forced = run(["stop", "--force"], e);
    expect(forced.status).toBe(0);
    expect(readFileSync(join(dir, "sys.log"), "utf8")).toContain("stop --no-block bb-server");
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toContain('"event":"stop_forced"');
    execFileSync("sqlite3", [db, "delete from lane_pilot_attempt;"]);
    expect(run(["stop"], e).status).toBe(0);
  });

  it("[sma:m_ctl_killed] a stop the process does not obey in time is escalated to a kill and said to have been hard", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const db = join(dir, "data.db");
    execFileSync("sqlite3", [db, "create table lane_pilot_attempt(id,task_id,state,thread_id);"]);
    writeFileSync(join(dir, "state"), "active\n");
    const e = { ...env, ...silentDoor, SYS_LOG: join(dir, "sys.log"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db, LP_WATCH_STOP_SEC: "1" };
    const hard = run(["stop"], e);
    expect(hard.status).toBe(0);
    expect(hard.stdout).toContain("stopped hard: the process did not leave in 1s and was killed");
    expect(readFileSync(join(dir, "sys.log"), "utf8")).toContain("kill -s SIGKILL bb-server");
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toContain('"event":"stopped_hard"');
    writeFileSync(join(dir, "state"), "inactive\n");
    const soft = run(["stop"], e);
    expect(soft.stdout).toContain("stopped:");
  });

  it("[sma:m_ctl_restart] [sma:m_ctl_lift_cmd] restart is stop, the platform lift and a wait on the door; its last line says whether the door answered", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const db = join(dir, "data.db");
    execFileSync("sqlite3", [db, "create table lane_pilot_attempt(id,task_id,state,thread_id);"]);
    writeFileSync(join(dir, "state"), "inactive\n");
    const base = { ...env, CURL_STATE: join(dir, "s"), SYS_LOG: join(dir, "sys.log"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db, LP_WATCH_RESTART_WAIT_SEC: "10" };
    const ok = run(["restart"], { ...base, CURL_AFTER: "3" });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim().split("\n").pop()).toMatch(/^ok: the door answers after \d+s$/);
    const down = run(["restart"], { ...base, ...silentDoor });
    expect(down.status).toBe(1);
    expect(down.stdout.trim().split("\n").pop()).toBe("down: the door did not answer in 10s");
    expect(readFileSync(join(dir, "sys.log"), "utf8")).toContain("restart bb-server");
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

  it("[sma:m_w_suspect] three refused connections or eight timeouts in a row declare an outage; a mixed row does not", async () => {
    const outageWithin = async (rc: string, after: number, seconds: number) => {
      const { dir, env } = tmp();
      stub(dir, "curl", CURL_STUB);
      const e = { ...process.env, ...env, LP_WATCH_DRY: "1", CURL_AFTER: "999999", CURL_RC: rc, CURL_STATE: join(dir, "s"), LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: String(after), LP_WATCH_REFUSED_AFTER: "3" };
      const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      proc.kill("SIGTERM");
      const log = join(dir, "outages.jsonl");
      return existsSync(log) ? readFileSync(log, "utf8") : "";
    };
    const refused = await outageWithin("7", 8, 5);
    expect(refused).toContain('"event":"outage"');
    expect(refused).toContain("refused");
    // two refused, a timeout, two refused: neither kind reaches its count in a row
    const { dir, env } = tmp();
    stub(dir, "curl", `seq="$(cat "$CURL_SEQ")"; n=0; [ -f "$CURL_STATE" ] && n=$(cat "$CURL_STATE"); echo $((n+1)) > "$CURL_STATE"; code=$(echo "$seq" | cut -d' ' -f$((n+1))); echo 000; exit "$code"`);
    writeFileSync(join(dir, "seq"), "7 7 28 7 7 28 7 7 28 7 7");
    const e = { ...process.env, ...env, LP_WATCH_DRY: "1", CURL_SEQ: join(dir, "seq"), CURL_STATE: join(dir, "s"), LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: "8", LP_WATCH_REFUSED_AFTER: "3" };
    const mixed = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    mixed.kill("SIGTERM");
    const mixedLog = join(dir, "outages.jsonl");
    expect(existsSync(mixedLog) ? readFileSync(mixedLog, "utf8") : "").not.toContain('"event":"outage"');
    const timeouts = await outageWithin("28", 8, 11);
    expect(timeouts).toContain('"event":"outage"');
    expect(timeouts).toContain("timeout");
  }, 40000);

  it("[sma:m_w_backoff] the backoff doubles counted from the last attempt on record, not process memory", () => {
    const { dir, env } = tmp();
    const now = Math.floor(Date.now() / 1000);
    const out = functions(`
      printf '{"at":%s,"event":"lift","detail":"a"}\\n{"at":%s,"event":"lift","detail":"b"}\\n' $(( $(date +%s) - 40 )) $(( $(date +%s) - 10 )) >> "$LOG"
      backoff_sec
      record "risen" "x"
      backoff_sec
    `, env);
    const [waitA, lastA, waitB] = out.trim().split(/\s+/);
    expect(Number(waitA)).toBe(120);
    const left = Number(waitA) - (now + 60 - Number(lastA)); // the wait left is reduced by the time since the last lift
    expect(left).toBeLessThan(Number(waitA));
    expect(Number(waitB)).toBe(30);
  });

  it("[sma:m_w_lifting] a repeated lift first kills whatever holds the port, and records it", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "ss", SS_STUB);
    writeFileSync(join(dir, "ss.out"), 'LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=9999,fd=1))\n');
    writeFileSync(join(dir, "mainpid"), "4242\n");
    const e = { ...env, CURL_AFTER: "9", CURL_STATE: join(dir, "s"), SS_OUT: join(dir, "ss.out"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_MAX_LIFTS: "2" };
    functions("lift || true", e);
    const log = readFileSync(join(dir, "outages.jsonl"), "utf8");
    expect(log).toContain('"event":"port_holder_killed"');
    expect(log).toContain("killing port holder 9999");
    expect(log.match(/port_holder_killed/g)).toHaveLength(1); // on try 2, not try 1
  }, 60000);

  it("[sma:m_out_marker] [sma:m_out_lift_failed] an outage record holds the first silence, the declaration, the messages and every lift attempt with its time; `outages` prints the block and `daily` counts it", async () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    writeFileSync(join(dir, "mainpid"), "4242\n");
    writeFileSync(join(dir, "state"), "active\n");
    const envFile = join(dir, "tg.env");
    writeFileSync(envFile, "TG_TOKEN=t\nTG_CHAT=1\n");
    writeFileSync(join(dir, "outages.jsonl"), `{"at":${Math.floor(Date.now() / 1000) - 100},"event":"lift","detail":"old"}\n`); // a spent attempt: the wait left is zero
    const e = { ...process.env, ...env, ...silentDoor, LP_WATCH_TG_ENV: envFile, CURL_STATE: join(dir, "s"), TG_LOG: join(dir, "tg.log"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_KNOCK_SEC: "1", LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1", RESTART_ERR: "Job failed. See journalctl", RESTART_RC: "1" };
    const proc = spawn("bash", [script, "run"], { env: e, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 9000));
    proc.kill("SIGTERM");
    const rows = readFileSync(join(dir, "outages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const events = rows.map((r) => r.event);
    const tail = events.slice(events.indexOf("first_silence")); // the seeded old lift and the 'start' line come first
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
      const out = run(["print-unit", which], env);
      expect(out.stdout).toContain("StartLimitBurst=5");
      expect(out.stdout).toContain("StartLimitIntervalSec=3600");
    }
  }, 20000);

  it("[sma:m_sp_install_watch] without administrator rights the install says the refusal in words before the fallback", () => {
    const { dir, env } = tmp();
    stub(dir, "sudo", "exit 1");
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "crontab", `cat >> "$CRON_LOG"`);
    writeFileSync(join(dir, "state"), "active\n");
    const e = { ...env, HOME: dir, SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "m"), STATE_FILE: join(dir, "state"), CRON_LOG: join(dir, "cron.log"), LP_WATCH_SYSTEMCTL: sys };
    const user = run(["install"], e);
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
      expect(out.stdout).toContain("first look waits 120 s");
      expect(out.stdout).toContain("StartLimitBurst=5");
    }
    const mac = run(["print-unit", "mac"], env);
    expect(mac.stdout).toContain("ThrottleInterval");
    expect(mac.stdout).toContain("first look waits 120 s");
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
    const second = spawnSync("bash", [script, "run"], { env: { ...e, PATH: `${join(dir, "bin")}:${restricted}` }, encoding: "utf8" });
    first.kill("SIGTERM");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("another watchdog runs");
  }, 30000);

  it("[sma:m_tl_crash] a writer process killed with SIGKILL mid-loop leaves a database db-ready calls ready, with no rows lost", () => {
    const { dir, env } = tmp();
    const db = join(dir, "stand.db");
    execFileSync("sqlite3", [db, "pragma journal_mode=WAL; create table beats(n integer);"]);
    const writer = spawn("bash", ["-c", `for i in $(seq 1 200000); do sqlite3 ${JSON.stringify(db)} 'insert into beats values (1);' 2>/dev/null; done`], { stdio: "ignore" });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      execFileSync("sleep", ["0.2"]);
      const count = spawnSync("sqlite3", ["-readonly", db, "select count(*) from beats;"], { encoding: "utf8" });
      ready = Number(count.stdout.trim()) > 10;
    }
    const before = Number(spawnSync("sqlite3", ["-readonly", db, "select count(*) from beats;"], { encoding: "utf8" }).stdout.trim());
    expect(before).toBeGreaterThan(10);
    writer.kill("SIGKILL");
    const check = run(["db-ready"], { ...env, LP_WATCH_DBS: db });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(`ready: ${db}`);
    const after = Number(spawnSync("sqlite3", ["-readonly", db, "select count(*) from beats;"], { encoding: "utf8" }).stdout.trim());
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
