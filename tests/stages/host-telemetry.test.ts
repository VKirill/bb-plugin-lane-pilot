import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOpenCodeTelemetry } from "../../src/host-handlers";

const read = (input:Parameters<typeof readOpenCodeTelemetry>[0]) => readOpenCodeTelemetry(input,{} as never);

describe("task-local OpenCode telemetry host reader", () => {
  it("returns bounded JSONL bytes and a content hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-pilot-telemetry-"));
    try {
      const content = `${JSON.stringify({ mod:"budget", ok:true, data:{tool:"read"}, task:"TASK.md", session:"s1" })}\n`;
      await writeFile(join(root, "opencode-lane.jsonl"), content);
      const result = await read({ requestedHostId:"host-test", projectCwd:root, relativePath:"opencode-lane.jsonl" });
      expect(result).toMatchObject({ hostId:"host-test", relativePath:"opencode-lane.jsonl", content, size:Buffer.byteLength(content) });
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { await rm(root, { recursive:true, force:true }); }
  });

  it("rejects traversal, symlinks, and files above the fixed byte cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-pilot-telemetry-"));
    try {
      await writeFile(join(root, "outside.jsonl"), "{}\n");
      await symlink(join(root, "outside.jsonl"), join(root, "linked.jsonl"));
      await expect(read({ requestedHostId:"host-test", projectCwd:root, relativePath:"../outside.jsonl" })).rejects.toThrow("project-relative");
      await expect(read({ requestedHostId:"host-test", projectCwd:root, relativePath:"linked.jsonl" })).rejects.toThrow("symlink");
      await writeFile(join(root, "large.jsonl"), "x".repeat(262145));
      await expect(read({ requestedHostId:"host-test", projectCwd:root, relativePath:"large.jsonl" })).rejects.toThrow("exceeds 262144 bytes");
    } finally { await rm(root, { recursive:true, force:true }); }
  });
});
