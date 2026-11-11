import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/hub-watchdog.sh");
const ship = fileURLToPath(new URL("../../scripts/lp-ship.ts", import.meta.url));
const drillSh = fileURLToPath(new URL("../../scripts/lp-drill.sh", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function run(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const done = spawnSync("bash", [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: done.status ?? 1, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
}

/** The script's case statement would run on source; the functions above it are the behaviour. */
function functionsRes(body: string, env: Record<string, string>): { status: number; stdout: string } {
  const source = `sed '/^case /,$d' ${JSON.stringify(script)}`;
  const done = spawnSync("bash", ["-c", `source <(${source})\n${body}`], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: done.status ?? 1, stdout: done.stdout ?? "" };
}
const functions = (body: string, env: Record<string, string>) => functionsRes(body, env).stdout;

function stub(dir: string, name: string, text: string): string {
  const path = join(dir, "bin", name);
  writeFileSync(path, `#!/bin/sh\n${text}\n`);
  chmodSync(path, 0o755);
  return path;
}

const CURL_STUB = `for a in "$@"; do
  case "$a" in *sendMessage*) echo "$@" >> "$TG_LOG"; exit "\${TG_RC:-0}" ;; esac
done
echo "\${CURL_CODE:-000}"; exit "\${CURL_RC:-28}"`;

const SYSTEMCTL_STUB = `echo "$*" >> "$SYS_LOG"
case "$*" in
  *"show -p MainPID"*) cat "$MAINPID_FILE" 2>/dev/null || echo 4242 ;;
  *"show -p ActiveState"*) cat "$STATE_FILE" 2>/dev/null || echo inactive ;;
  *"show -p Result"*) echo failure; echo 1 ;;
  *"show -p ControlGroup"*) echo "$UNIT_CG" ;;
esac
exit 0`;

const SS_STUB = `cat "$SS_OUT" 2>/dev/null`;
const SLEEP_STUB = `echo "$1" >> "$SLEEP_LOG"`;

const dirs: string[] = [];
function tmp(): { dir: string; bin: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "lp-sma-h1-"));
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
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const silentDoor = { CURL_CODE: "000", CURL_RC: "28" };

describe("hub watchdog + ship gate parity H1", () => {
  it("[sma:m_ctl_lift_cmd] the watchdog's lift runs the same command lift_cmd emits on every platform branch", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    stub(dir, "sleep", SLEEP_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "launchctl", `echo "$*" >> "$LCTL_LOG"; exit 0`);
    writeFileSync(join(dir, "mainpid"), "4242\n");
    const base = { ...env, ...silentDoor, SYS_LOG: join(dir, "sys.log"), LCTL_LOG: join(dir, "lctl.log"), SLEEP_LOG: join(dir, "sleep.log"), MAINPID_FILE: join(dir, "mainpid"), LP_WATCH_SYSTEMCTL: sys, LP_WATCH_MAX_LIFTS: "1", LP_WATCH_SERVICE: "bb-server" };
    // each variant: the lift's log holds the command lift_cmd prints for it
    for (const e of [{ ...base, LP_WATCH_USER: "1" }, { ...base, LP_WATCH_PLATFORM: "darwin" }] as Array<Record<string, string>>) {
      rmSync(join(dir, "sys.log"), { force: true });
      rmSync(join(dir, "lctl.log"), { force: true });
      const cmd = functions("lift_cmd", e).trim();
      functions("lift || true", e);
      const log = `${read(join(dir, "sys.log"))}\n${read(join(dir, "lctl.log"))}`;
      expect(log, `cmd: ${cmd}`).toContain(cmd.split(" ").slice(-2).join(" ")); // the verb and the service land as lift_cmd printed them
      if (e.LP_WATCH_PLATFORM === "darwin") expect(log).toContain("kickstart -k");
      else expect(log).toContain("--user restart bb-server");
    }
    // restart and lift share it: the detached restart invokes exactly `$(lift_cmd)`
    expect(readFileSync(script, "utf8")).toContain('setsid nohup bash -c "$(lift_cmd)"');
  }, 30000);

  it("[sma:m_ctl_exit] a door answered from a foreign process is a refusal a flag lifts: exit 2 from status, stop, restart and lift; --force goes on", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "ss", SS_STUB);
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    dirs.push(dir);
    try {
      writeFileSync(join(dir, "ss.out"), `LISTEN 0 1 127.0.0.1:38886 0.0.0.0:* users:(("node",pid=${other.pid},fd=1))\n`);
      writeFileSync(join(dir, "mainpid"), "4242\n");
      writeFileSync(join(dir, "state"), "active\n");
      const db = join(dir, "data.db");
      execFileSync("sqlite3", [db, "create table lane_pilot_attempt(id,task_id,state,thread_id);"]);
      const e = { ...env, CURL_CODE: "200", CURL_RC: "0", SS_OUT: join(dir, "ss.out"), SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, LP_WATCH_LP_DB: db, UNIT_CG: "/lp-test.slice/bb-server.service", LP_WATCH_STOP_SEC: "1" };
      for (const verb of ["status", "stop", "restart", "lift"]) {
        const out = run([verb], e);
        expect(out.status, verb).toBe(2);
        expect(out.stdout, verb).toContain("process unproven");
        expect(out.stdout, verb).toContain("--force");
      }
      const forced = run(["stop", "--force"], e);
      expect(forced.stdout).toContain("--force given, going on");
      expect(read(join(dir, "sys.log"))).toContain("stop --no-block bb-server");
    } finally {
      other.kill("SIGKILL");
    }
  }, 30000);

  it("[sma:m_sp_watch_loop] [sma:m_sp_watch_xml] the default units write the two-minute first look and the five-restarts cap as real lines, and a crashed watchdog tells the owner before systemd's cap can give up", () => {
    const { dir, env } = tmp();
    stub(dir, "curl", CURL_STUB);
    // unset install: the delay and the cap are real lines in every unit type, not comments or env-only
    for (const which of ["system", "user"]) {
      const out = run(["print-unit", which], env);
      expect(out.stdout, which).toContain("Environment=LP_WATCH_FIRST_SEC=120");
      expect(out.stdout, which).toContain("StartLimitIntervalSec=3600");
      expect(out.stdout, which).toContain("StartLimitBurst=5");
      expect(run(["print-unit", which], { ...env, LP_WATCH_RESTART_CAP: "0" }).stdout).not.toContain("StartLimit");
    }
    const mac = run(["print-unit", "mac"], env);
    expect(mac.stdout).toContain("<key>LP_WATCH_FIRST_SEC</key><string>120</string>");
    expect(mac.stdout).toContain("<key>ThrottleInterval</key><integer>720</integer>");
    // the dying word: a crash (exit 42) is recorded and sent; a stop signal (143) or a clean leave is silent
    const e = { ...env, LP_WATCH_DRY: "1", CURL_CODE: "200", CURL_RC: "0" };
    const crash = functionsRes("rotate() { exit 42; }; run", e);
    expect(crash.status).toBe(42);
    const log = read(join(dir, "outages.jsonl"));
    expect(log).toContain('"event":"watchdog_exit"');
    expect(log).toContain("exit 42");
    expect(log).toContain('"event":"message_not_sent"'); // no tg.env here: the reason is recorded, the send itself is not faked
    rmSync(join(dir, "outages.jsonl"));
    const stopped = functionsRes("rotate() { exit 143; }; run", e);
    expect(stopped.status).toBe(143);
    expect(read(join(dir, "outages.jsonl"))).not.toContain("watchdog_exit");
  }, 30000);

  it("[sma:k_lib_releaselint] predict-lint fails on a promise in the newest CHANGELOG entry only; older entries are printed warnings", () => {
    const changelog = join(repoRoot, "CHANGELOG.md");
    const original = readFileSync(changelog, "utf8");
    try {
      const run_lint = () => spawnSync("npx", ["tsx", ship, "predict-lint"], { encoding: "utf8", timeout: 120_000, cwd: repoRoot });
      const clean = run_lint();
      expect(clean.status).toBe(0);
      writeFileSync(changelog, original.replace("# Changelog\n", "# Changelog\n\n## 9.9.9\n\n- everything is faster now\n"));
      const planted = run_lint();
      expect(planted.status).toBe(1);
      expect(planted.stdout).toContain("CHANGELOG 9.9.9");
    } finally {
      writeFileSync(changelog, original);
    }
  }, 300000);

  it("[sma:k_lib_releaselint] lp-drill.sh --quick (the deploy path) runs predict-lint before the drill and stops on a finding", () => {
    const bin = mkdtempSync(join(tmpdir(), "lp-fakebin-h1-"));
    dirs.push(bin);
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "npx $@" >> ${log}\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, "python3"), `#!/bin/sh\necho "python3 $@" >> ${log}\necho RECEIPT=/tmp/x.json\nexit 0\n`, { mode: 0o755 });
    const res = spawnSync("bash", [drillSh, "--quick"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const calls = read(log);
    expect(calls).toContain("predict-lint");
    expect(calls).not.toContain("python3");
    expect(res.status).toBe(1);
  });

  it("[sma:k_v_prepublish] [sma:m_tl_rebrand_wired] [sma:k_lib_pkgcheck] [sma:k_lib_docaudit] [sma:k_lib_spafresh] npm's prepublishOnly runs the gate: build first, freshness with an unreachable hub a warning, then the strict checks", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.prepublishOnly).toBe("npm run gate");
    expect(pkg.scripts?.gate).toContain("lp-ship.ts gate");
    const { dir } = tmp();
    // a bb that cannot build: the gate stops first, nothing else runs
    const bbFail = stub(dir, "bb", "exit 1");
    const failed = spawnSync("npx", ["tsx", ship, "gate"], { encoding: "utf8", timeout: 240_000, cwd: repoRoot, env: { ...process.env, BB_CLI: bbFail } });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("bb plugin build failed");
    // a bb that builds but whose hub cannot be asked for the served version: freshness warns, never fails
    const version = (pkg as { version: string }).version;
    const bbOk = stub(dir, "bb2", `case "$1 $2" in "plugin build") exit 0 ;; "plugin list") echo '[{"id":"lane-pilot","version":"${version}"}]' ;; esac\nexit 0`);
    const gated = spawnSync("npx", ["tsx", ship, "gate"], { encoding: "utf8", timeout: 240_000, cwd: repoRoot, env: { ...process.env, BB_CLI: bbOk } });
    expect(gated.status).toBe(1); // publishable --strict fails in a development tree: no dist build, no test receipt
    expect(gated.stdout).toContain("windowBundle");
    expect(gated.stdout).toContain("gate: publishable failed");
    expect(gated.stdout).not.toContain("gate: freshness failed");
  }, 300000);

  it("[sma:k_lib_docaudit] doc-audit --strict writes no baseline file; only the explicit --write-baseline flag does", () => {
    const baseline = join(repoRoot, ".agents/ship/doc-coverage-baseline.json");
    const before = existsSync(baseline) ? readFileSync(baseline, "utf8") : null;
    try {
      spawnSync("npx", ["tsx", ship, "doc-audit", "--strict"], { encoding: "utf8", timeout: 240_000, cwd: repoRoot });
      expect(existsSync(baseline) ? readFileSync(baseline, "utf8") : null).toBe(before);
      if (before === null) {
        spawnSync("npx", ["tsx", ship, "doc-audit", "--strict", "--write-baseline"], { encoding: "utf8", timeout: 240_000, cwd: repoRoot });
        expect(existsSync(baseline)).toBe(true);
      }
    } finally {
      if (before === null) rmSync(baseline, { force: true });
      else writeFileSync(baseline, before);
    }
  }, 300000);
});
