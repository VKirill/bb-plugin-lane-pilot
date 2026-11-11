import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWatchdog, script, run, functions, stub, CURL_STUB, SYSTEMCTL_STUB, SLEEP_STUB, until, read, tmp, silentDoor } from "../helpers/hub-watchdog";

// One of three files (parity-d1-watchdog, -2, -3): the tests wait in real time for the watchdog's knocks, so they are spread over three
// files that run in separate workers. What they share is tests/helpers/hub-watchdog.ts.
afterEach(cleanupWatchdog);

describe("hub watchdog parity D1", () => {
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
    // Each outage has its own folder and its own watchdog, so the two thirteen-second waits run together.
    const [same, other] = await Promise.all([runOutage("4242"), runOutage("5151")]);
    expect(same.log).toContain('"event":"false_alarm"');
    expect(same.log).not.toContain('"event":"risen"');
    expect(same.tg).toContain("тревога была ложной");
    expect(other.log).toContain('"event":"risen"');
    expect(other.tg).toContain("поднялся");
  }, 30000);

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
});
