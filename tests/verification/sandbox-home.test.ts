import { mkdtemp, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSandboxedCommandOnHost } from "../../src/rooms/verification/sandbox";

it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "lets a sandboxed check write its own HOME, as vitest does for its token",
  async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "lp-sandbox-ws-")));
    const result = await runSandboxedCommandOnHost({
      requestedHostId: "host", workspacePath: workspace, cwd: workspace, backend: "auto",
      command: 'mkdir -p "$HOME/Library/Application Support/vitest" && echo t > "$HOME/Library/Application Support/vitest/token" && echo ok',
    } as never);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  },
);

it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "reports a command killed at its time limit as exit 124, not as a plain failure",
  async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "lp-sandbox-ws-")));
    const result = await runSandboxedCommandOnHost({
      requestedHostId: "host", workspacePath: workspace, cwd: workspace, backend: "auto", command: "sleep 30", timeoutSec: 1,
    } as never);
    expect(result.exitCode).toBe(124);
  },
);

it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "keeps the host worker answering while a sandboxed check runs",
  async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "lp-sandbox-ws-")));
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      const result = await runSandboxedCommandOnHost({
        requestedHostId: "host", workspacePath: workspace, cwd: workspace, backend: "auto", command: "sleep 0.5",
      } as never);
      expect(result.exitCode).toBe(0);
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(5);
  },
);

it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "keeps a green check green when it prints more than a megabyte, with its summary at the end",
  async () => {
    // The replay before a merge ran SelfyStudio's API vitest here: green, 2.5 MB of logs, killed at 1 MB and read as
    // exit 1 (proj_acpiaqf4wq, 2026-10-14/15, three «checks red after the replay on main»).
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "lp-sandbox-ws-")));
    const run = (exit: number) => runSandboxedCommandOnHost({
      requestedHostId: "host", workspacePath: workspace, cwd: workspace, backend: "auto", timeoutSec: 60,
      command: `for i in $(seq 1 25000); do echo '{"level":30,"msg":"request completed","responseTime":1.23456789,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'; done; echo ' Test Files  ${exit ? "1 failed | " : ""}248 passed (248)'; exit ${exit}`,
    } as never);
    const green = await run(0);
    expect(green.exitCode).toBe(0);
    expect(green.stdout).toContain("Test Files  248 passed (248)");
    const red = await run(1);
    expect(red.exitCode).toBe(1);
    expect(red.stdout).toContain("Test Files  1 failed | 248 passed (248)");
  },
);

it("finds the bb CLI folder from BB_CLI or PATH so sandboxed checks can run bb plugin build", async () => {
  const { bbCliDir } = await import("../../src/rooms/verification/sandbox");
  expect(bbCliDir({ BB_CLI: "/opt/bb/dist/bb" })).toBe("/opt/bb/dist");
  expect(bbCliDir({ PATH: "relative:/nonexistent-dir" })).toBeNull();
});
