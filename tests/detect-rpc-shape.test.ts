import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostContract } from "../src/contracts";
import { detect } from "../src/host-handlers";

describe("detect RPC output", () => {
  it("matches the host contract and does not leak compatibility", async () => {
    const home = mkdtempSync(join(tmpdir(), "lane-pilot-detect-rpc-"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = await detect({
        requestedHostId: "host_test",
        workspacePath: home,
      }, {} as never);
      expect(result).not.toHaveProperty("compatibility");
      expect(hostContract.detect.output.parse(result).scenario).toMatch(/^S[123]$/);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });
});
