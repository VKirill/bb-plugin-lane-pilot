import { mkdtemp, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSandboxedCommandOnHost } from "../../src/verification/sandbox";

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

it("finds the bb CLI folder from BB_CLI or PATH so sandboxed checks can run bb plugin build", async () => {
  const { bbCliDir } = await import("../../src/verification/sandbox");
  expect(bbCliDir({ BB_CLI: "/opt/bb/dist/bb" })).toBe("/opt/bb/dist");
  expect(bbCliDir({ PATH: "relative:/nonexistent-dir" })).toBeNull();
});
