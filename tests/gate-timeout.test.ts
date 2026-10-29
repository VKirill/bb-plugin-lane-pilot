import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readCheckRun } from "../src/rooms/tasks/server/check-reading";
import { runGateOnHost } from "../src/rooms/verification/integration-gate-host";

it("A-036 a timed-out gate is not successful when its TERM handler exits zero", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "audit-gate-timeout-"));
  try {
    const result = await runGateOnHost({ basePath: cwd, command: "trap 'exit 0' TERM; while :; do sleep 0.02; done", timeoutSec: 1 });
    expect(result.stderr).toContain("ETIMEDOUT");
    expect.soft(readCheckRun(result, { command: "custom-gate" }).verdict).not.toBe("pass");
    expect(result.exitCode, JSON.stringify(result)).not.toBe(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
