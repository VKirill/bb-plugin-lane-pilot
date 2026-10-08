import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCommandOnHost } from "../src/rooms/writer/cli-run";

/** How often a 20 ms timer fired while `work` ran: a host call that blocks the worker leaves it at zero. */
async function ticksDuring(work:()=>Promise<unknown>):Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try { await work(); } finally { clearInterval(timer); }
  return ticks;
}

describe("runCommandOnHost", () => {
  it("returns output larger than the default 1 MB spawn buffer", async () => {
    const ran = await runCommandOnHost({ requestedHostId:"h", cwd:tmpdir(), command:"head -c 3000000 /dev/zero | tr '\\0' x" });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toHaveLength(3_000_000);
  });

  it("reports why a command was killed instead of an empty stderr", async () => {
    const ran = await runCommandOnHost({ requestedHostId:"h", cwd:tmpdir(), command:"sleep 5", timeoutSec:1 });
    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr).toMatch(/ETIMEDOUT|SIGTERM/);
  });

  // A host worker blocked in a command cannot answer the daemon: its other calls miss their deadline and the
  // daemon SIGKILLs the worker (OVH, 2026-10-05).
  it("keeps the host worker answering while a command runs", async () => {
    const ticks = await ticksDuring(() => runCommandOnHost({ requestedHostId:"h", cwd:tmpdir(), command:"sleep 0.5" }));
    expect(ticks).toBeGreaterThan(5);
  });
});
