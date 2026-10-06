import { describe, expect, it } from "vitest";
import { parseWorkspaceMode } from "../src/workspace/routing";
import { diffDirectoryHashes, snapshotDirectoryHashes } from "../src/hash";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("worktree-only unit tests", () => {
  it("parses legacy in_place and Russian label as auto", () => {
    expect(parseWorkspaceMode("in_place")).toBe("auto");
    expect(parseWorkspaceMode("В папке проекта")).toBe("auto");
    expect(parseWorkspaceMode("auto")).toBe("auto");
    expect(parseWorkspaceMode("worktree")).toBe("worktree");
    expect(parseWorkspaceMode(undefined)).toBe("auto");
    expect(parseWorkspaceMode("")).toBe("auto");
  });

  it("non-git workspace snapshot calculates produced files from hashes and ignores excluded dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-nongit-"));
    try {
      await writeFile(join(dir, "owned.ts"), "initial content\n");
      await mkdir(join(dir, ".agents"), { recursive: true });
      await writeFile(join(dir, ".agents", "plan.md"), "plan\n");
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "node_modules", "package.json"), "{}\n");

      const before = await snapshotDirectoryHashes(dir);
      expect(before.has("owned.ts")).toBe(true);
      expect(before.has(".agents/plan.md")).toBe(false);
      expect(before.has("node_modules/package.json")).toBe(false);

      // Writer edits owned.ts, creates new.ts, and creates noise in .bb/
      await writeFile(join(dir, "owned.ts"), "modified content\n");
      await writeFile(join(dir, "new.ts"), "new file\n");
      await mkdir(join(dir, ".bb", "chats"), { recursive: true });
      await writeFile(join(dir, ".bb", "chats", "chat.json"), "{}\n");

      const after = await snapshotDirectoryHashes(dir);
      const diff = diffDirectoryHashes(before, after);

      expect(diff).toEqual(["new.ts", "owned.ts"]);
      expect(diff).not.toContain(".bb/chats/chat.json");
      expect(diff).not.toContain(".agents/plan.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("diffDirectoryHashes detects deleted files", () => {
    const before = new Map([
      ["a.txt", "hash-a"],
      ["b.txt", "hash-b"],
    ]);
    const after = new Map([
      ["a.txt", "hash-a-modified"],
    ]);
    const diff = diffDirectoryHashes(before, after);
    expect(diff).toEqual(["a.txt", "b.txt"]);
  });

  it("subfolder workspace and worktree-only invariants are met", () => {
    expect(parseWorkspaceMode("in_place")).toBe("auto");
    expect(parseWorkspaceMode("В папке проекта")).toBe("auto");
  });
});
