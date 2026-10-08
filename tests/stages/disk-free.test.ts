import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { hostContract } from "../../src/contracts";
import { diskFree } from "../../src/rooms/host-worker/host-handlers";

it("diskFree reports free and total bytes of the filesystem under a path", async () => {
  const result = await diskFree({ requestedHostId: "host-test", path: tmpdir() }, {} as never);
  expect(hostContract.diskFree.output.parse(result)).toMatchObject({ hostId: "host-test", path: tmpdir() });
  expect(result.totalBytes).toBeGreaterThan(0);
  expect(result.freeBytes).toBeGreaterThan(0);
  expect(result.freeBytes).toBeLessThanOrEqual(result.totalBytes);
  await expect(diskFree({ requestedHostId: "host-test", path: "/nonexistent-lane-pilot-path" }, {} as never)).rejects.toThrow();
});
