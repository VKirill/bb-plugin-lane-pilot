import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/hub-watchdog.sh");

function run(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (cause) {
    const error = cause as { status?: number; stdout?: string; stderr?: string };
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

describe("supervisor scripts", () => {
  it("[sma:m_sp_watch_cli] status names a door that does not answer, and an unknown verb is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sma-cli-"));
    try {
      const env = { LP_WATCH_STATE: dir, LP_WATCH_DRY: "1", LP_WATCH_DOOR: "http://127.0.0.1:1/no", LP_WATCH_TG_ENV: join(dir, "no-telegram") };
      const status = run(["status"], env);
      expect(status.status).toBe(1);
      expect(status.stdout).toContain("the door does not answer");
      const unknown = run(["nope"], env);
      expect(unknown.status).toBe(2);
      expect(unknown.stderr).toContain("run|status|stop|restart|lift|install|daily|rotate|db-ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.todo("[sma:m_sp_watch_loop] the loop waits before the first look, then caps a fallen watchdog's restarts");

  it.todo("[sma:m_sp_logon_xml] the logon task starts 30 seconds after logon, restarts three times, and is shipped disabled");

  it.todo("[sma:m_sp_pg_sandbox] the product queue is a Postgres sandbox");

  it.todo("[sma:m_sp_pg_old_road] Postgres comes from the hand-made sandbox");

  it.todo("[sma:m_sp_pg_db] the queue database is created");

  it.todo("[sma:m_sp_tjournal] a terminal journal records work done outside the daemon");

  it.todo("[sma:m_sp_tjournal_report] the report's last number is a week of work from the window");
});
