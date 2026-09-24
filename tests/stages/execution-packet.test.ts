import { describe, expect, it } from "vitest";
import { buildExecutionPacket, renderExecutionPacket } from "../../src/stages/execution-packet";

describe("bounded execution packet", () => {
  it("reads exact requested lines and carries the inspected source hash", async () => {
    const packet = await buildExecutionPacket(["docs/guide.md L2-L3"], async (path) => {
      expect(path).toBe("docs/guide.md");
      return { content:"one\ntwo\nthree\nfour", sha256:"a".repeat(64), sizeBytes:18 };
    });
    expect(packet.entries).toEqual([{ path:"docs/guide.md", sha256:"a".repeat(64), windows:[{ startLine:2, endLine:3, excerpt:"two\nthree" }] }]);
    expect(renderExecutionPacket(packet)).toContain("two\\nthree");
    expect(packet.truncated).toBe(false);
    expect(packet.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when a requested file or line window is unavailable", async () => {
    await expect(buildExecutionPacket(["README.md"], async () => null)).rejects.toThrow("source is unavailable");
    await expect(buildExecutionPacket(["README.md L9-L10"], async () => ({ content:"short" }))).rejects.toThrow("outside README.md");
  });

  it("bounds the prompt packet when selected source exceeds the packet budget", async () => {
    const packet = await buildExecutionPacket(["README.md"], async () => ({ content:"x".repeat(40_000) }));
    expect(packet.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(packet), "utf8")).toBeLessThan(25_000);
  });
});
