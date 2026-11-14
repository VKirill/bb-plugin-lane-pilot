// Region 12 · Supervisor, batch b (n1027 … n1035): the startup entries of the watchdog. The script runs for real against stub tools; the guide is
// compared with what the script prints and installs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SYSTEMCTL_STUB, cleanupWatchdog, run, stub, tmp } from "../helpers/hub-watchdog";

afterEach(cleanupWatchdog);

const guide = () => readFileSync(join(process.cwd(), "docs/watchdog.md"), "utf8");

describe("supervisor startup entries", () => {
  it("[sma:m_sp_try_task] with no user systemd the install writes one @reboot crontab line that runs the loop, replaces the watchdog's old line and keeps the person's other lines", () => {
    const { dir, env } = tmp();
    stub(dir, "sudo", "exit 1");
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    stub(dir, "crontab", `case "$1" in
  -l) cat "$CRON_IN" ;;
  -) cat > "$CRON_OUT" ;;
esac`);
    writeFileSync(join(dir, "cron-in"), "0 3 * * * /usr/bin/backup\n@reboot /bin/bash /old/place/hub-watchdog.sh run\n");
    const done = run(["install"], { ...env, HOME: dir, SYS_LOG: join(dir, "sys.log"), LP_WATCH_SYSTEMCTL: sys, USERCTL_RC: "1", CRON_IN: join(dir, "cron-in"), CRON_OUT: join(dir, "cron-out") });
    expect(done.stdout).toContain("no user systemd here: using an @reboot crontab line");
    expect(done.stdout).toContain("installed: @reboot crontab line");
    const lines = readFileSync(join(dir, "cron-out"), "utf8").trim().split("\n");
    const self = run(["print-unit", "user"], env).stdout.match(/ExecStart=\/bin\/bash (\S+) run/)![1]!;
    expect(lines).toEqual(["0 3 * * * /usr/bin/backup", `@reboot /bin/bash ${self} run >> ${dir}/hub-watchdog.log 2>&1`]);
    // Nothing else was registered: no user unit file was written.
    expect(existsSync(join(dir, ".config/systemd/user/lp-hub-watchdog.service"))).toBe(false);
  });

  it("[sma:m_sp_shortcut] the guide's no-administrator entries are what the script installs: the user unit path, the same run command for the Windows shortcut, and a startup folder the guide leaves to Windows", () => {
    const text = guide();
    const linux = text.slice(text.indexOf("## Linux"), text.indexOf("## macOS"));
    const windows = text.slice(text.indexOf("## Windows"));
    const { dir, env } = tmp();
    // Linux without admin: the guide names the user unit file the install really writes.
    const unitPath = /~\/(\.config\/systemd\/user\/lp-hub-watchdog\.service)/.exec(linux)?.[1];
    expect(unitPath).toBeDefined();
    stub(dir, "sudo", "exit 1");
    const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
    const installed = run(["install"], { ...env, HOME: dir, SYS_LOG: join(dir, "sys.log"), MAINPID_FILE: join(dir, "m"), STATE_FILE: join(dir, "state"), LP_WATCH_SYSTEMCTL: sys });
    expect(installed.stdout).toContain("installed: user unit lp-hub-watchdog.service");
    const unit = readFileSync(join(dir, unitPath!), "utf8");
    expect(unit).toContain("WantedBy=default.target");
    // Windows: the shortcut is «с той же командой» as the logon task, and that command is the verb the script's own unit runs.
    const noAdmin = windows.split("\n").filter((line) => line.includes("Без прав администратора"));
    expect(noAdmin).toHaveLength(1);
    expect(noAdmin[0]).toBe("Без прав администратора — ярлык в `shell:startup` с той же командой.");
    const task = /\/TR "bash -lc '([^']+)'"/.exec(windows)?.[1];
    expect(task).toMatch(/^~\/[\w./-]*scripts\/hub-watchdog\.sh run$/);
    const verb = unit.match(/ExecStart=\/bin\/bash \S+ (\w+)/)?.[1];
    expect(task!.endsWith(` ${verb}`)).toBe(true);
    // The guide gives the folder by its Windows name and never a path of its own.
    expect(windows).not.toMatch(/AppData|C:\\|%APPDATA%/);
  });

  it("[sma:m_sp_watch_plist] on a Mac the install writes the LaunchAgent that runs the loop at login and keeps it alive, replaces a loaded one and then runs the selfcheck", () => {
    const { dir, env } = tmp();
    mkdirSync(join(dir, "Library/LaunchAgents"), { recursive: true });
    stub(dir, "launchctl", `echo "$*" >> "$LCTL_LOG"; exit 0`);
    const done = run(["install"], { ...env, HOME: dir, LP_WATCH_PLATFORM: "darwin", LCTL_LOG: join(dir, "lctl.log") });
    expect(done.stdout).toContain("installed: LaunchAgent pro.vechkasov.lp-hub-watchdog");
    expect(done.stdout).toMatch(/selfcheck: \d+ failure\(s\)/);
    const plistPath = join(dir, "Library/LaunchAgents/pro.vechkasov.lp-hub-watchdog.plist");
    const plist = readFileSync(plistPath, "utf8");
    const self = run(["print-unit", "user"], env).stdout.match(/ExecStart=\/bin\/bash (\S+) run/)![1]!;
    expect(plist).toContain("<key>Label</key><string>pro.vechkasov.lp-hub-watchdog</string>");
    expect(plist).toContain(`<string>${self}</string><string>run</string>`);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).not.toContain("[Unit]");
    const calls = readFileSync(join(dir, "lctl.log"), "utf8").trim().split("\n");
    const domain = calls[0]!.split(" ")[1]!;
    expect(domain).toMatch(/^gui\/\d+$/);
    expect(calls.slice(0, 2)).toEqual([`bootout ${domain} ${plistPath}`, `bootstrap ${domain} ${plistPath}`]);
  }, 60_000);
});
