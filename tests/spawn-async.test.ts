import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { spawnAsync } from "../src/spawn-async";

describe("spawnAsync", () => {
  it("returns status and both streams like spawnSync", async () => {
    const ran = await spawnAsync("/bin/bash", ["-c", "echo out; echo err >&2; exit 3"], { cwd:tmpdir() });
    expect(ran).toMatchObject({ status:3, signal:null, stdout:"out\n", stderr:"err\n" });
    expect(ran.error).toBeUndefined();
  });

  it("kills a command at its time limit with ETIMEDOUT", async () => {
    const ran = await spawnAsync("/bin/bash", ["-c", "sleep 5"], { timeout:200 });
    expect(ran.status).toBeNull();
    expect(ran.signal).toBe("SIGTERM");
    expect(ran.error?.code).toBe("ETIMEDOUT");
  });

  it("kills a command that overfills maxBuffer with ENOBUFS", async () => {
    const ran = await spawnAsync("/bin/bash", ["-c", "head -c 200000 /dev/zero; sleep 5"], { maxBuffer:1000, timeout:4_000 });
    expect(ran.error?.code).toBe("ENOBUFS");
  });

  it("reports a missing binary as a launch error", async () => {
    const ran = await spawnAsync("/nonexistent/lane-pilot-binary", []);
    expect(ran.status).toBeNull();
    expect(ran.error?.code).toBe("ENOENT");
  });

  it("does not wait for a background process that holds the pipes", async () => {
    const started = Date.now();
    const ran = await spawnAsync("/bin/bash", ["-c", "sleep 8 & echo started"]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("started\n");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
