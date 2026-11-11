import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWatchdog, script, drillPy, run, functions, stub, CURL_STUB, SYSTEMCTL_STUB, SS_STUB, SLEEP_STUB, holder, read, pathWithout, tmp, silentDoor } from "../helpers/hub-watchdog";

// One of three files (parity-d1-watchdog, -2, -3): the tests wait in real time for the watchdog's knocks, so they are spread over three
// files that run in separate workers. What they share is tests/helpers/hub-watchdog.ts.
afterEach(cleanupWatchdog);

describe("hub watchdog parity D1", () => {
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
    const seenThenRefused = `n=0; [ -f "$CURL_STATE" ] && n=$(cat "$CURL_STATE"); echo $((n+1)) > "$CURL_STATE"; if [ "$n" -lt 1 ]; then echo 200; exit 0; fi; echo 000; exit 7`;
    const mixedCurl = `seq="$(cat "$CURL_SEQ")"; n=0; [ -f "$CURL_STATE" ] && n=$(cat "$CURL_STATE"); echo $((n+1)) > "$CURL_STATE"; code=$(echo "$seq" | cut -d' ' -f$((n+1))); echo 000; exit "\${code:-0}"`;
    const { dir: seqDir } = tmp();
    writeFileSync(join(seqDir, "seq"), "7 7 28 7 7 28 7 7 28 7 7");
    // Every scenario waits in real time for knocks a second apart, in its own folder with its own watchdog: they wait together.
    const [seven, early, eight, fast, short, timeouts, mixed] = await Promise.all([
      outageWithin({ CURL_AFTER: "7", CURL_RC: "7" }, 11),
      outageWithin({ CURL_AFTER: "999999", CURL_RC: "7" }, 5),
      outageWithin({ CURL_AFTER: "999999", CURL_RC: "7" }, 11),
      outageWithin({}, 6, seenThenRefused),
      outageWithin({ LP_WATCH_REFUSED_AFTER: "2" }, 5, seenThenRefused),
      outageWithin({ CURL_AFTER: "999999", CURL_RC: "28" }, 11),
      outageWithin({ CURL_SEQ: join(seqDir, "seq"), LP_WATCH_REFUSED_AFTER: "5" }, 11, mixedCurl),
    ]);
    // seven refused knocks, then the door answers: no outage (a count of three would have declared it)
    expect(seven).not.toContain('"event":"outage"');
    // refused for good: declared at the eighth, not before
    expect(early).not.toContain('"event":"outage"');
    expect(eight).toContain('"event":"outage"');
    expect(eight).toContain("refused");
    // refused knocks declare at three, but only once the door has answered 200 (the seen-200 marker): before it the eight-knock rule stands
    expect(fast).toContain('"event":"outage"');
    // a longer count is a setting
    expect(short).toContain('"event":"outage"');
    // eight timeouts
    expect(timeouts).toContain('"event":"outage"');
    expect(timeouts).toContain("timeout");
    // main counts a mixed row as silence too: refused and timeouts together reach eight
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
