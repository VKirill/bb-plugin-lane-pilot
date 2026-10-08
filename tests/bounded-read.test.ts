import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOUNDED_READ_MAX_SLICE_BYTES,
  readBoundedWorkspaceFile,
} from "../src/bounded-read";

async function fixtureDir() {
  const root = await mkdtemp(join(tmpdir(), "lp-bounded-read-"));
  await mkdir(join(root, "src"));
  return root;
}

describe("readBoundedWorkspaceFile", () => {
  it("returns N lines of N+1 and does not put the extra line in the payload", async () => {
    const root = await fixtureDir();
    const body = "one\ntwo\nthree";
    await writeFile(join(root, "src/note.txt"), body);
    const result = await readBoundedWorkspaceFile({
      hostId: "host-a",
      projectCwd: root,
      relativePath: "src/note.txt",
      offset: 0,
      maxLines: 2,
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      hostId: "host-a",
      path: "src/note.txt",
      content: "one\ntwo",
      contentEncoding: "utf8",
      totalLines: 3,
      offset: 0,
      maxLines: 2,
      lineStart: 1,
      lineEnd: 2,
      truncated: true,
    });
    expect(result.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(result.sizeBytes).toBe(Buffer.byteLength(body));
    expect(result.returnedBytes).toBe(Buffer.byteLength(result.content));
    expect(JSON.stringify(result)).not.toContain("three");
  });

  it("rejects binary and invalid UTF-8 without treating them as lines", async () => {
    const root = await fixtureDir();
    await writeFile(join(root, "src/nul.bin"), Buffer.from("ok\0no"));
    await writeFile(join(root, "src/bad.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(readBoundedWorkspaceFile({
      hostId: "host-a", projectCwd: root, relativePath: "src/nul.bin", offset: 0, maxLines: 10,
    })).rejects.toThrow(/binary_rejected/);
    await expect(readBoundedWorkspaceFile({
      hostId: "host-a", projectCwd: root, relativePath: "src/bad.bin", offset: 0, maxLines: 10,
    })).rejects.toThrow(/not_valid_utf8/);
  });

  it("rejects symlink escape even when the link sits inside the workspace", async () => {
    const root = await fixtureDir();
    const outside = join(root, "..", `outside-${Date.now()}.txt`);
    await writeFile(outside, "secret\n");
    await symlink(outside, join(root, "src/link.txt"));
    await expect(readBoundedWorkspaceFile({
      hostId: "host-a", projectCwd: root, relativePath: "src/link.txt", offset: 0, maxLines: 10,
    })).rejects.toThrow(/symlink/);
  });

  it("caps transferred slice bytes independently of remaining file lines", async () => {
    const root = await fixtureDir();
    const line = "x".repeat(BOUNDED_READ_MAX_SLICE_BYTES - 10);
    await writeFile(join(root, "src/wide.txt"), `${line}\n${line}\n`);
    const result = await readBoundedWorkspaceFile({
      hostId: "host-a",
      projectCwd: root,
      relativePath: "src/wide.txt",
      offset: 0,
      maxLines: 2,
    });
    expect(result.content).toBe(line);
    expect(result.returnedBytes).toBeLessThanOrEqual(BOUNDED_READ_MAX_SLICE_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(3);
    expect(result.content.includes("\n")).toBe(false);
  });
});
