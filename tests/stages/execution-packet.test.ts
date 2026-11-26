import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOURCE_BYTES } from "@lane-pilot/contracts";
import { readBoundedWorkspaceFile } from "@lane-pilot/kit";
import { buildExecutionPacket, renderExecutionPacket, type BoundSlice, type ReadFirstIo, type ReadFirstFile, type SliceOutcome } from "../../src/rooms/tasks";
import { readFirstIo } from "../../src/rooms/tasks/server";

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

/** A fake bounded host: serves line slices from `lines` with whole-file metadata, like readBoundedFile. */
function boundedIo(opts: {
  lines: string[];
  sizeBytes?: number;
  sha256?: string;
  whole?: ReadFirstFile | null;
  wholeReads?: string[];
  sliceSha256?: (call: number) => string;
  onSlice?: (offset: number, maxLines: number) => void;
}): { io: ReadFirstIo; sliceCalls: Array<{ offset: number; maxLines: number }> } {
  const sha = opts.sha256 ?? "b".repeat(64);
  const sliceCalls: Array<{ offset: number; maxLines: number }> = [];
  let calls = 0;
  const io: ReadFirstIo = {
    readWhole: async (path) => {
      opts.wholeReads?.push(path);
      return opts.whole ?? null;
    },
    readSlice: async (_path, offset, maxLines): Promise<SliceOutcome> => {
      calls += 1;
      sliceCalls.push({ offset, maxLines });
      opts.onSlice?.(offset, maxLines);
      const selected = opts.lines.slice(offset, offset + maxLines);
      const content = selected.join("\n");
      const slice: BoundSlice = {
        content,
        sha256: opts.sliceSha256 ? opts.sliceSha256(calls) : sha,
        sizeBytes: opts.sizeBytes ?? Buffer.byteLength(opts.lines.join("\n"), "utf8"),
        totalLines: opts.lines.length,
        lineStart: offset + 1,
        lineEnd: selected.length === 0 ? offset : offset + selected.length,
        returnedBytes: Buffer.byteLength(content, "utf8"),
        truncated: offset + selected.length < opts.lines.length,
      };
      return { kind: "slice", slice };
    },
  };
  return { io, sliceCalls };
}

describe("bounded execution packet sources", () => {
  it("reads an explicit window on a >512KiB source through bounded slices only", async () => {
    const lines = Array.from({ length: 9_000 }, (_, i) => `row-${i + 1},${"x".repeat(80)}`);
    const wholeReads: string[] = [];
    const { io, sliceCalls } = boundedIo({ lines, sizeBytes: 800 * 1024, wholeReads });
    const packet = await buildExecutionPacket(["data.csv:100-120"], io);
    expect(wholeReads).toEqual([]);
    expect(sliceCalls).toEqual([{ offset: 99, maxLines: 21 }]);
    expect(packet.entries).toEqual([{ path: "data.csv", sha256: "b".repeat(64),
      windows: [{ startLine: 100, endLine: 120, excerpt: lines.slice(99, 120).join("\n") }] }]);
  });

  it("pages a window past the 2000-line host bound and keeps the whole-file hash", async () => {
    const lines = Array.from({ length: 4_500 }, (_, i) => `L${i + 1}`);
    const { io, sliceCalls } = boundedIo({ lines });
    const packet = await buildExecutionPacket(["big.txt:1-2100"], io);
    expect(sliceCalls).toEqual([{ offset: 0, maxLines: 2000 }, { offset: 2000, maxLines: 100 }]);
    expect(packet.entries[0]?.windows).toEqual([{ startLine: 1, endLine: 2100, excerpt: lines.slice(0, 2100).join("\n") }]);
    expect(packet.entries[0]?.sha256).toBe("b".repeat(64));
    expect(packet.truncated).toBe(false);
  });

  it("rejects when the whole-file hash changes across pages", async () => {
    const lines = Array.from({ length: 4_500 }, (_, i) => `L${i + 1}`);
    const { io } = boundedIo({ lines, sliceSha256: (call) => (call === 1 ? "b".repeat(64) : "c".repeat(64)) });
    await expect(buildExecutionPacket(["big.txt:1-2100"], io)).rejects.toThrow("changed while reading: big.txt");
  });

  it("rejects when the whole-file identity changes between windows", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
    const { io } = boundedIo({ lines, sliceSha256: (call) => (call === 1 ? "b".repeat(64) : "c".repeat(64)) });
    await expect(buildExecutionPacket(["f.txt:1-10,50-60"], io)).rejects.toThrow("changed while reading: f.txt");
  });

  it("defers a windowless source over 512KiB to a required on-site read with its proven hash", async () => {
    const lines = Array.from({ length: 6_000 }, (_, i) => `row-${i},${"y".repeat(100)}`);
    const wholeReads: string[] = [];
    const { io } = boundedIo({ lines, sizeBytes: MAX_SOURCE_BYTES + 1, wholeReads });
    const packet = await buildExecutionPacket(["huge.csv"], io);
    expect(wholeReads).toEqual([]);
    expect(packet.entries[0]?.missing).toBeUndefined();
    expect(packet.entries[0]?.sha256).toBe("b".repeat(64));
    expect(packet.entries[0]?.deferred?.reason).toContain("exceeds");
    expect(packet.truncated).toBe(false);
    const rendered = renderExecutionPacket(packet);
    expect(rendered).toContain("huge.csv (whole file;");
    expect(rendered).toContain("file sha256 bbbbbbbb");
    expect(rendered).toContain("read it on site before executing");
  });

  it("defers a source beyond the host read limit without a guessed hash", async () => {
    const { io } = boundedIo({ lines: ["x"], sizeBytes: 9 * 1024 * 1024 });
    const packet = await buildExecutionPacket(["enormous.bin:1-5"], io);
    expect(packet.entries[0]?.deferred?.reason).toContain("host read limit");
    expect(packet.entries[0]?.deferred?.windows).toEqual([{ startLine: 1, endLine: 5 }]);
    expect(packet.entries[0]?.sha256).toBe("");
    expect(renderExecutionPacket(packet)).toContain("content hash unknown");
  });

  it("keeps the whole-file path for a windowless source the probe proves small", async () => {
    const wholeReads: string[] = [];
    const { io, sliceCalls } = boundedIo({
      lines: ["a", "b", "c"], wholeReads,
      whole: { content: "a\nb\nc", sha256: "d".repeat(64), sizeBytes: 5 },
    });
    const packet = await buildExecutionPacket(["small.txt"], io);
    expect(sliceCalls).toEqual([{ offset: 0, maxLines: 1 }]);
    expect(wholeReads).toEqual(["small.txt"]);
    expect(packet.entries[0]?.sha256).toBe("d".repeat(64));
    expect(packet.entries[0]?.windows).toEqual([{ startLine: 1, endLine: 3, excerpt: "a\nb\nc" }]);
  });

  it("keeps missing, deferred and thrown slice outcomes distinct", async () => {
    const outcomes: Record<string, SliceOutcome> = {
      "gone.txt": { kind: "missing" },
      "blocked.txt": { kind: "deferred", reason: "not readable as text" },
    };
    const { io } = boundedIo({ lines: ["x"] });
    const mixed: ReadFirstIo = {
      ...io,
      readSlice: async (path, offset, maxLines) => {
        if (path === "boom.txt") throw new Error("transport reset");
        return outcomes[path] ?? io.readSlice(path, offset, maxLines);
      },
    };
    const packet = await buildExecutionPacket(["gone.txt:1-1", "blocked.txt:1-1"], mixed);
    expect(packet.entries[0]?.missing).toBe(true);
    expect(packet.entries[1]?.deferred?.reason).toBe("not readable as text");
    await expect(buildExecutionPacket(["boom.txt:1-1"], mixed)).rejects.toThrow("transport reset");
  });

  it("keeps every requested path visible as deferred once the packet budget is spent", async () => {
    const readPaths: string[] = [];
    const packet = await buildExecutionPacket(["big.md", "b.txt:5-9", "c.txt"], async (path) => {
      readPaths.push(path);
      return path === "big.md" ? { content: "x".repeat(40_000) } : { content: "small" };
    });
    // The spent budget defers the rest without reading their content just to fill excerpts.
    expect(readPaths).toEqual(["big.md"]);
    expect(packet.entries.map((entry) => entry.path)).toEqual(["big.md", "b.txt", "c.txt"]);
    expect(packet.entries[1]?.deferred?.windows).toEqual([{ startLine: 5, endLine: 9 }]);
    expect(packet.entries[1]?.sha256).toBe("");
    expect(packet.entries[2]?.deferred?.windows).toEqual([]);
    const rendered = renderExecutionPacket(packet);
    expect(rendered).toContain("b.txt L5-L9");
    expect(rendered).toContain("c.txt (whole file");
    expect(rendered).toContain("packet budget is spent");
  });

  it("keeps later windows of the same hint visible when the excerpt budget cuts mid-entry", async () => {
    const lines = Array.from({ length: 6_000 }, (_, i) => `L${i + 1} ${"y".repeat(30)}`);
    const { io } = boundedIo({ lines });
    const packet = await buildExecutionPacket(["f.txt:1-1000,5000-5010"], io);
    const entry = packet.entries[0];
    expect(entry?.windows).toEqual([{ startLine: 1, endLine: 1000, excerpt: expect.any(String) }]);
    expect(entry?.deferred?.windows).toEqual([{ startLine: 5000, endLine: 5010 }]);
    expect(entry?.deferred?.reason).toContain("packet budget");
    expect(entry?.sha256).toBe("b".repeat(64));
    const rendered = renderExecutionPacket(packet);
    expect(rendered).toContain("f.txt L1-L1000");
    expect(rendered).toContain("f.txt L5000-L5010");
    expect(rendered).toContain("read it on site before executing");
  });

  it("defers the uncovered tail of a window the host read bound cut short", async () => {
    const lines = Array.from({ length: 103_000 }, (_, i) => `L${i + 1}`);
    const { io } = boundedIo({ lines });
    const packet = await buildExecutionPacket(["huge.txt:99000-102000"], io);
    const entry = packet.entries[0];
    expect(entry?.windows).toEqual([{ startLine: 99000, endLine: 100999, excerpt: expect.any(String) }]);
    expect(entry?.deferred?.windows).toEqual([{ startLine: 101000, endLine: 102000 }]);
    expect(entry?.deferred?.reason).toContain("host read bound");
    expect(renderExecutionPacket(packet)).toContain("huge.txt L101000-L102000");
  });
});

describe("readFirstIo error classification", () => {
  const failingFiles = (error: unknown) => ({ read: async () => { throw error; } });
  const failingHost = (error: unknown) => ({ call: async () => { throw error; } });
  const io = (files: { read: () => Promise<unknown> }, host: { call: () => Promise<unknown> }) =>
    readFirstIo({ files: files as never, host: host as never }, { hostId: "h", rootPath: "/repo" });

  it("maps absent whole-file reads to null, permission and malformed results to named failures", async () => {
    await expect(io(failingFiles(new Error("ENOENT: no such file or directory")), failingHost(new Error("x")))
      .readWhole("missing.txt")).resolves.toBeNull();
    await expect(io({ read: async () => ({ content: 42 }) }, failingHost(new Error("x")))
      .readWhole("odd.bin")).rejects.toThrow("no text content");
    await expect(io(failingFiles(new Error("EACCES: permission denied")), failingHost(new Error("x")))
      .readWhole("secret.txt")).rejects.toThrow("EACCES");
  });

  it("classifies slice failures into missing, deferred and named outcomes", async () => {
    const slice = (message: string) => io(failingFiles(new Error("unused")), failingHost(new Error(message))).readSlice("a.txt", 0, 1);
    await expect(slice("lane_pilot_read_target_must_be_regular_file")).resolves.toEqual({ kind: "missing" });
    await expect(slice("lane_pilot_read_file_exceeds_8388608_bytes")).resolves.toMatchObject({ kind: "deferred" });
    await expect(slice("lane_pilot_read_binary_rejected")).resolves.toMatchObject({ kind: "deferred", reason: "not readable as text" });
    await expect(slice("host has no such method readBoundedFile")).resolves.toMatchObject({ kind: "deferred", reason: expect.stringContaining("bounded file reads") });
    await expect(slice("lane_pilot_read_path_escaped_workspace")).rejects.toThrow("escaped");
    await expect(slice("socket hangup")).rejects.toThrow("socket hangup");
  });

  it("classifies real primitive absence as missing through readFirstIo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-readfirst-"));
    writeFileSync(join(dir, "present.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(dir, "file.txt"), "not a dir\n");
    // The real kit primitive behind the host contract, no all-host setup: contract input is
    // mapped to the primitive's shape the way the host-worker handler does.
    const io = readFirstIo(
      {
        files: { read: async () => ({ content: "" }) },
        host: {
          call: async (_method: string, input: { projectCwd: string; relativePath: string; offset: number; maxLines: number }) => readBoundedWorkspaceFile({
            hostId: "h", projectCwd: input.projectCwd, relativePath: input.relativePath,
            offset: input.offset, maxLines: input.maxLines,
          }),
        } as never,
      },
      { hostId: "h", rootPath: dir },
    );
    await expect(io.readSlice("missing.txt", 0, 1)).resolves.toEqual({ kind: "missing" });
    await expect(io.readSlice("file.txt/child", 0, 1)).resolves.toEqual({ kind: "missing" });
    await expect(io.readSlice("present.txt", 0, 2)).resolves.toMatchObject({
      kind: "slice",
      slice: { content: "alpha\nbeta", totalLines: 4, lineStart: 1, lineEnd: 2 },
    });
  });
});
