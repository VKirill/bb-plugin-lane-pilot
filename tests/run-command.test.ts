import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCommandOnHost } from "../src/cli-run";

describe("runCommandOnHost", () => {
  it("returns output larger than the default 1 MB spawn buffer", () => {
    const ran = runCommandOnHost({ requestedHostId:"h", cwd:tmpdir(), command:"head -c 3000000 /dev/zero | tr '\\0' x" });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toHaveLength(3_000_000);
  });

  it("reports why a command was killed instead of an empty stderr", () => {
    const ran = runCommandOnHost({ requestedHostId:"h", cwd:tmpdir(), command:"sleep 5", timeoutSec:1 });
    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr).toMatch(/ETIMEDOUT|SIGTERM/);
  });
});
