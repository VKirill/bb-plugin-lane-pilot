import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { hostContract } from "../src/rooms/contracts";
import { diskFree } from "../src/rooms/host-worker/host-handlers";
import { darwinAvailableBytes, readingFrom } from "../src/rooms/verification";

/** `vm_stat` of the Mac mini, 2026-10-26: `os.freemem()` said 0.4 % free on the same machine. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4250.
Pages active:                                 154072.
Pages inactive:                               152575.
Pages speculative:                               551.
Pages throttled:                                   0.
Pages wired down:                             303734.
Pages purgeable:                                   4.
`;

describe("the machine reading before a check", () => {
  it("macOS available memory is free + inactive + speculative pages, not os.freemem", () => {
    expect(darwinAvailableBytes(VM_STAT)).toBe((4250 + 152575 + 551) * 16384);
    expect(darwinAvailableBytes("nothing useful")).toBeNull();
  });

  it("diskFree answers the machine's load and memory only when asked", async () => {
    const plain = await diskFree({ requestedHostId: "h", path: tmpdir() }, {} as never);
    expect(plain).not.toHaveProperty("machine");
    const asked = hostContract.diskFree.output.parse(await diskFree({ requestedHostId: "h", path: tmpdir(), machine: true }, {} as never));
    expect(asked.machine?.cpuCount).toBeGreaterThan(0);
    expect(asked.machine?.memTotalBytes).toBeGreaterThan(0);
    expect(asked.machine?.memFreeBytes).toBeGreaterThan(0);
  });

  it("a host answer becomes a reading; no answer is no reading, and a host without the machine part gives no load", () => {
    expect(readingFrom(null)).toBeNull();
    expect(readingFrom({ hostId: "h", freeBytes: 10, totalBytes: 100 }, 5)).toEqual({ hostId: "h", at: 5, load1: null, cpuCount: null, memFreeBytes: null, memTotalBytes: null, diskFreeBytes: 10, diskTotalBytes: 100 });
  });
});
