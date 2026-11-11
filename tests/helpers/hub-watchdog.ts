/** What the hub watchdog parity tests (tests/sma/parity-d1-watchdog*.test.ts) share: the script paths, the stub tools and the temp folders. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const script = join(process.cwd(), "scripts/hub-watchdog.sh");
export const pushScript = join(process.cwd(), "scripts/lp-owner-push.sh");
export const drillPy = join(process.cwd(), "scripts/lp-drill.py");

export function run(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const done = spawnSync("bash", [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: done.status ?? 1, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
}

/** The script's case statement would run on source; the functions above it are the behaviour. */
export function functions(body: string, env: Record<string, string>): string {
  const source = `sed '/^case /,$d' ${JSON.stringify(script)}`;
  return execFileSync("bash", ["-c", `source <(${source})\n${body}`], { env: { ...process.env, ...env }, encoding: "utf8" });
}

export function stub(dir: string, name: string, text: string): string {
  const path = join(dir, "bin", name);
  writeFileSync(path, `#!/bin/sh\n${text}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** curl stub: a POST to .../sendMessage is logged to $TG_LOG and returns $TG_RC; anything else prints the http_code. */
export const CURL_STUB = `for a in "$@"; do
  case "$a" in *sendMessage*) echo "$@" >> "$TG_LOG"; exit "\${TG_RC:-0}" ;; esac
done
n=0; [ -f "$CURL_STATE" ] && n="$(cat "$CURL_STATE")"
echo $((n + 1)) > "$CURL_STATE"
if [ "$n" -ge "\${CURL_AFTER:-999999}" ]; then echo 200; exit 0; fi
echo "\${CURL_CODE:-000}"; exit "\${CURL_RC:-0}"`;

export const SYSTEMCTL_STUB = `echo "$*" >> "$SYS_LOG"
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

export const SS_STUB = `cat "$SS_OUT" 2>/dev/null`;

/** sleep stub: logs its argument and returns at once, so a wait of minutes is read from the log, not waited out. */
export const SLEEP_STUB = `echo "$1" >> "$SLEEP_LOG"`;

/** A process the test starts itself, to stand for the port holder; the watchdog may only signal it under its rules. */
export function holder(): { pid: number; alive: () => boolean; stop: () => void; cgroup: () => string } {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  const pid = child.pid!;
  const alive = () => { try { process.kill(pid, 0); return !readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2].startsWith("Z"); } catch { return false; } };
  const cgroup = () => { try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n")[0].replace(/^[^:]*:[^:]*:/, ""); } catch { return ""; } };
  holders.push(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  return { pid, alive, stop: () => child.kill("SIGKILL"), cgroup };
}
export const holders: Array<() => void> = [];

export async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return check();
}
export const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A stub bin dir with everything from /usr/bin and /bin except the named tools (to fake a missing prerequisite). */
export function pathWithout(...missing: string[]): string {
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

export const dirs: string[] = [];
export function tmp(): { dir: string; bin: string; env: Record<string, string> } {
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
/** Removes the folders and stand-in processes a test made; every file that uses this kit runs it after each test. */
export const cleanupWatchdog = () => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); while (holders.length) holders.pop()!(); };

export const silentDoor = { CURL_AFTER: "999999", CURL_CODE: "000", CURL_RC: "28" };
