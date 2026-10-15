import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { spawnAsync } from "@lane-pilot/kit";

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

  it("with keepEnds, lets a command that prints a lot finish and keeps its beginning and end", async () => {
    // SelfyStudio's green API vitest printed 2.5 MB of request logs; a 1 MB cap killed it and the replay read exit 1.
    const ran = await spawnAsync("/bin/bash", ["-c", "echo first; head -c 2500000 /dev/zero | tr '\\0' x; echo; echo ' Test Files  248 passed (248)'; exit 0"], { keepEnds:200_000, timeout:20_000 });
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(0);
    expect(ran.stdout.startsWith("first\n")).toBe(true);
    expect(ran.stdout).toContain("Test Files  248 passed (248)");
    expect(ran.stdout).toMatch(/\[\.\.\. \d+ bytes cut \.\.\.\]/);
    expect(ran.stdout.length).toBeLessThan(201_000);
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
