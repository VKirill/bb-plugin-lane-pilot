import { describe, expect, it } from "vitest";
import { buildExecutionPacket, renderExecutionPacket } from "../../src/rooms/tasks/execution-packet";

describe("bounded execution packet", () => {
  it("reads exact requested lines and carries the inspected source hash", async () => {
    const packet = await buildExecutionPacket(["docs/guide.md L2-L3"], async (path) => {
      expect(path).toBe("docs/guide.md");
      return { content:"one\ntwo\nthree\nfour", sha256:"a".repeat(64), sizeBytes:18 };
    });
    expect(packet.entries).toEqual([{ path:"docs/guide.md", sha256:"a".repeat(64), windows:[{ startLine:2, endLine:3, excerpt:"two\nthree" }] }]);
    expect(renderExecutionPacket(packet)).toBe("Read these before editing; they are the context for this task:\n- docs/guide.md L2-L3 (sha256 aaaaaaaa)");
    expect(packet.truncated).toBe(false);
    expect(packet.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("notes a missing or unreadable source instead of blocking the attempt", async () => {
    const packet = await buildExecutionPacket(["README.md", "docs/"], async (path) => {
      if (path === "docs/") throw new Error("HTTP 400: Path is a directory, not a file");
      return null;
    });
    expect(packet.entries).toEqual([
      { path:"README.md", sha256:"", windows:[], missing:true },
      { path:"docs/", sha256:"", windows:[], missing:true },
    ]);
    expect(renderExecutionPacket(packet)).toContain("- README.md (not in the workspace; skip it)");
  });

  it("fails closed when a requested line window is outside the file", async () => {
    await expect(buildExecutionPacket(["README.md L9-L10"], async () => ({ content:"short" }))).rejects.toThrow("outside README.md");
  });

  it("bounds the prompt packet when selected source exceeds the packet budget", async () => {
    const packet = await buildExecutionPacket(["README.md"], async () => ({ content:"x".repeat(40_000) }));
    expect(packet.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(packet), "utf8")).toBeLessThan(25_000);
  });
});

it("gives pm-read the excerpt text itself", async () => {
  const { renderPacketExcerpts } = await import("../../src/rooms/tasks/execution-packet");
  const text = renderPacketExcerpts({ sha256: "x", entries: [{ path: "a.ts", sha256: "abc", windows: [{ startLine: 1, endLine: 2, excerpt: "const a = 1;\nconst b = 2;" }] }] } as never);
  expect(text).toContain("### a.ts L1-L2");
  expect(text).toContain("const b = 2;");
});
