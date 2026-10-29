import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/hub-watchdog.sh");

function run(args: string[], env: Record<string, string>): { status: number; stdout: string } {
  try {
    return { status: 0, stdout: execFileSync("bash", [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" }) };
  } catch (cause) {
    const error = cause as { status?: number; stdout?: string };
    return { status: error.status ?? 1, stdout: error.stdout ?? "" };
  }
}

/** The script's case statement would run on source; the functions above it are the behaviour. */
function functions(body: string, env: Record<string, string>): string {
  const source = `sed '/^case /,$d' ${JSON.stringify(script)}`;
  return execFileSync("bash", ["-c", `source <(${source})\n${body}`], { env: { ...process.env, ...env }, encoding: "utf8" });
}

describe("hub watchdog", () => {
  it("[sma:m_sp_pg_ready] [sma:m_sp_sql_ready] readiness is a real query: a database that answers quick_check in UTF-8 is ready, a file and a missing path are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sma-db-"));
    try {
      const ok = join(dir, "ok.db");
      const junk = join(dir, "junk.db");
      execFileSync("sqlite3", [ok, "CREATE TABLE t(x);"]);
      writeFileSync(junk, "this is not a database");
      const missing = join(dir, "missing.db");
      const result = run(["db-ready"], { LP_WATCH_DBS: `${ok} ${junk} ${missing}` });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`ready: ${ok}`);
      expect(result.stdout).toContain(`not ready: ${junk}`);
      expect(result.stdout).toContain(`missing: ${missing}`);
      expect(result.stdout).not.toContain("38886");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[sma:m_sp_watch_restart] five lifts inside the window refuse the next one and record no further lift", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sma-lift-"));
    const out = functions(`
      for n in 1 2 3 4 5; do record lift "seed $n"; done
      lift || true
      echo ---
      cat "$LOG"
    `, {
      LP_WATCH_STATE: dir,
      LP_WATCH_DOOR: "http://127.0.0.1:1/no",
      LP_WATCH_DRY: "1",
      LP_WATCH_MAX_LIFTS_IN_WINDOW: "5",
      LP_WATCH_TG_ENV: join(dir, "no-telegram"),
    });
    expect(out).toContain("lift_refused");
    expect(out.match(/"event":"lift"/g)).toHaveLength(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("[sma:m_sp_already] an open door is left alone: the lift records that it skipped and does not count a lift", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sma-door-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), "#!/bin/sh\necho 200\n");
    chmodSync(join(bin, "curl"), 0o755);
    const out = functions(`lift || true\necho ---\ncat "$LOG"`, {
      LP_WATCH_STATE: dir,
      LP_WATCH_DRY: "1",
      LP_WATCH_TG_ENV: join(dir, "no-telegram"),
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(out).toContain("nothing to do: the door answers");
    expect(out).toContain("lift_skipped");
    expect(out).not.toContain('"event":"lift"');
    rmSync(dir, { recursive: true, force: true });
  });

  it("[sma:m_sp_log_day] [sma:m_sp_lift_log] a line belongs to its day, and the daily count is that day's events", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sma-log-"));
    const yesterday = new Date(Date.now() - 86_400_000);
    const at = Math.floor(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 12) / 1000);
    const day = yesterday.toISOString().slice(0, 10);
    writeFileSync(join(dir, "outages.jsonl"), `{"at":${at},"event":"lift","detail":"old"}\n`);
    const rotated = run(["rotate"], { LP_WATCH_STATE: dir });
    expect(rotated.stdout).toContain(`rotated: outages-${day}.jsonl`);
    expect(readFileSync(join(dir, `outages-${day}.jsonl`), "utf8")).toContain('"event":"lift"');
    expect(readFileSync(join(dir, "outages.jsonl"), "utf8")).toBe("");
    writeFileSync(join(dir, "outages.jsonl"), `{"at":${Math.floor(Date.now() / 1000)},"event":"lift","detail":"today"}\n`);
    const daily = run(["daily"], { LP_WATCH_STATE: dir });
    expect(daily.stdout).toContain(`${day} lift 1`);
    expect(daily.stdout).toMatch(/\d{4}-\d{2}-\d{2} lift 1/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("[sma:m_sp_watch_lock] a second watchdog finds the lock and leaves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sma-lock-"));
    const env = { ...process.env, LP_WATCH_STATE: dir, LP_WATCH_DOOR: "http://127.0.0.1:1/no", LP_WATCH_DRY: "1", LP_WATCH_KNOCK_SEC: "30", LP_WATCH_TG_ENV: join(dir, "no-telegram") };
    const first = spawn("bash", [script, "run"], { env, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = run(["run"], env);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("another watchdog runs");
    } finally {
      first.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.todo("[sma:m_sp_utf8] a database encoding cannot change, so a new database is made and swapped in"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:m_sp_utf8_refuse] the swap is refused while the daemon is connected"); // deferral:dfr_seed_skip_sma_gaps
});
