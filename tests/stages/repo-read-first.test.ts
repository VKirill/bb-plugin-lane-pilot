import { execFileSync } from "node:child_process";
import { readFirstIo, repoReadRoot } from "../../src/rooms/tasks/server";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOURCE_BYTES } from "@lane-pilot/contracts";
import { readBoundedWorkspaceFile } from "@lane-pilot/kit";
import { buildExecutionPacket, parseReadFirstHints, parseReadFirstSelector, renderExecutionPacket } from "../../src/rooms/tasks";

const ownedRoots:string[]=[];
afterEach(()=>{for(const root of ownedRoots.splice(0)) rmSync(root,{recursive:true,force:true});});

/**
 * Two independent temp repositories, no linked worktree: `repo/` holds the section
 * (`repo/section`, the task cwd) plus sibling files; `other/` is an unrelated repo that
 * must never be touched. `notes.txt` exists in both repo root and section with different
 * content so scope confusion is observable.
 */
function repoFixture() {
  const base = mkdtempSync(join(tmpdir(), "lp-repo-read-"));
  ownedRoots.push(base);
  const repoRoot = join(base, "repo");
  const section = join(repoRoot, "section");
  const other = join(base, "other-repo");
  mkdirSync(join(repoRoot, "sdk", "deep"), { recursive: true });
  mkdirSync(section, { recursive: true });
  mkdirSync(join(other, "sdk"), { recursive: true });
  execFileSync("git",["init","-q",repoRoot]);
  execFileSync("git",["init","-q",other]);
  writeFileSync(join(repoRoot, "notes.txt"), "repo-root version\n");
  writeFileSync(join(section, "notes.txt"), "section version\n");
  writeFileSync(join(repoRoot, "sdk", "index.ts"), "export const sdk = 1;\n");
  writeFileSync(join(repoRoot, "sdk", "deep", "util.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(other, "sdk", "index.ts"), "unrelated repo\n");
  return { base, repoRoot, section, other };
}

/** Real adapters: files.read hits the actual fs; host.call is the real bounded-read primitive. */
function realIo(rootPath: string, repoRootPath: string | null) {
  const reads: Array<{ rootPath: string; path: string }> = [];
  const calls: Array<{ projectCwd: string; relativePath: string }> = [];
  const io = readFirstIo(
    {
      files: {
        read: async (args: { hostId: string; rootPath: string; path: string }) => {
          reads.push({ rootPath: args.rootPath, path: args.path });
          const content = readFileSync(args.path, "utf8");
          return {
            content,
            sha256: createHash("sha256").update(content).digest("hex"),
            sizeBytes: Buffer.byteLength(content, "utf8"),
          };
        },
      } as never,
      host: {
        call: async (_method: string, input: { projectCwd: string; relativePath: string; offset: number; maxLines: number }) => {
          calls.push({ projectCwd: input.projectCwd, relativePath: input.relativePath });
          return readBoundedWorkspaceFile({
            hostId: "h", projectCwd: input.projectCwd, relativePath: input.relativePath,
            offset: input.offset, maxLines: input.maxLines,
          });
        },
      } as never,
    },
    { hostId: "h", rootPath, repoRootPath },
  );
  return { io, reads, calls };
}

describe("parseReadFirstSelector", () => {
  it("splits the canonical repo selector and leaves workspace paths alone", () => {
    expect(parseReadFirstSelector("repo:sdk/index.ts")).toEqual({ scope: "repo", path: "sdk/index.ts" });
    expect(parseReadFirstSelector("src/a.ts")).toEqual({ scope: "workspace", path: "src/a.ts" });
    expect(parseReadFirstSelector("docs/repo:notes.md")).toEqual({ scope: "workspace", path: "docs/repo:notes.md" });
  });
});

describe("parseReadFirstHints repo selector", () => {
  it("keeps the canonical repo: selector in the stored path with line windows", () => {
    expect(parseReadFirstHints(["repo:sdk/index.ts", "repo:./sdk/deep/util.ts:2-3"])).toEqual([
      { path: "repo:sdk/index.ts", windows: [] },
      { path: "repo:sdk/deep/util.ts", windows: [{ startLine: 2, endLine: 3 }] },
    ]);
  });

  it.each([
    "repo:",
    "repo:../x.ts",
    "repo:/abs.ts",
    "repo:a\\b.ts",
    "repo:C:/x.ts",
    "repo:repo:x.ts",
    "repo:.git/config",
    "repo:sdk/.agents/plans/x.md",
    "repo:a/b/.bb/chats/thr_x/y.md",
    "repo:.Git/config", "repo:sibling/.AGENTS/secret.md",
  ])("rejects unsafe repo read_first %s", (hint) => {
    expect(() => parseReadFirstHints([hint])).toThrow("repo:");
  });

  it("preserves legacy workspace validation", () => {
    expect(() => parseReadFirstHints(["../x.ts"])).toThrow("project-relative");
    expect(() => parseReadFirstHints(["/etc/passwd"])).toThrow("project-relative");
    expect(parseReadFirstHints(["./src/a.ts"]).map((hint) => hint.path)).toEqual(["src/a.ts"]);
    expect(parseReadFirstHints([".agents/tasks/self/notes.md"]).map((hint) => hint.path)).toEqual([".agents/tasks/self/notes.md"]);
  });
});

describe("readFirstIo repo scope", () => {
  it("discovers the actual destination checkout root through the host command",async()=>{
    const source=repoFixture(), target=repoFixture();
    writeFileSync(join(target.repoRoot,"sdk/index.ts"),"target SDK\n");
    const host={call:async(_method:"runCommand",input:{command:string;cwd:string;requestedHostId:string})=>({hostId:input.requestedHostId,exitCode:0,stdout:execFileSync("bash",["-c",input.command],{cwd:input.cwd,encoding:"utf8"}),stderr:""})};
    const found=await repoReadRoot(host,"h",target.section,["repo:sdk/index.ts"]);
    expect(found?.root).toBe(target.repoRoot);
    const packet=await buildExecutionPacket(["repo:sdk/index.ts"],realIo(target.section,found?.root??null).io);
    expect(packet.entries[0]?.windows[0]?.excerpt).toContain("target SDK");
    expect(readFileSync(join(source.repoRoot,"sdk/index.ts"),"utf8")).toBe("export const sdk = 1;\n");
  });

  it("reads the same filename from the section vs the repository root by selector", async () => {
    const { repoRoot, section } = repoFixture();
    const { io, reads, calls } = realIo(section, repoRoot);

    const sectionFile = await io.readWhole("notes.txt");
    const repoFile = await io.readWhole("repo:notes.txt");
    expect(sectionFile?.content).toBe("section version\n");
    expect(repoFile?.content).toBe("repo-root version\n");
    expect(reads).toEqual([
      { rootPath: section, path: join(section, "notes.txt") },
      { rootPath: repoRoot, path: join(repoRoot, "notes.txt") },
    ]);

    const sectionSlice = await io.readSlice("notes.txt", 0, 1);
    const repoSlice = await io.readSlice("repo:notes.txt", 0, 1);
    expect(sectionSlice).toMatchObject({ kind: "slice", slice: { content: "section version" } });
    expect(repoSlice).toMatchObject({ kind: "slice", slice: { content: "repo-root version" } });
    expect(calls.slice(-2)).toEqual([
      { projectCwd: section, relativePath: "notes.txt" },
      { projectCwd: repoRoot, relativePath: "notes.txt" },
    ]);
  });

  it("serves bounded slices of nested repo paths through the real primitive", async () => {
    const { repoRoot, section } = repoFixture();
    const { io, calls } = realIo(section, repoRoot);
    const slice = await io.readSlice("repo:sdk/deep/util.ts", 1, 2);
    expect(slice).toMatchObject({ kind: "slice", slice: { content: "line2\nline3", lineStart: 2, lineEnd: 3 } });
    expect(calls[0]).toEqual({ projectCwd: repoRoot, relativePath: "sdk/deep/util.ts" });
  });

  it("never resolves repo: paths against an unrelated repository", async () => {
    const { repoRoot, section, other } = repoFixture();
    const { io, reads, calls } = realIo(section, repoRoot);
    await io.readWhole("repo:sdk/index.ts");
    await io.readSlice("repo:sdk/index.ts", 0, 1);
    expect(reads[0]?.path).toBe(join(repoRoot, "sdk", "index.ts"));
    expect(reads[0]?.path).not.toContain(other);
    expect(calls[0]?.projectCwd).toBe(repoRoot);
    expect(calls[0]?.projectCwd).not.toBe(other);
  });

  it("keeps the repo: selector in packet entries and deferred on-site labels", async () => {
    const { repoRoot, section } = repoFixture();
    writeFileSync(join(repoRoot, "sdk", "huge.csv"), "x".repeat(MAX_SOURCE_BYTES + 1));
    const { io } = realIo(section, repoRoot);
    const packet = await buildExecutionPacket(["repo:sdk/huge.csv", "repo:missing.txt"], io);
    expect(packet.entries.map((entry) => entry.path)).toEqual(["repo:sdk/huge.csv", "repo:missing.txt"]);
    expect(packet.entries[0]?.deferred?.reason).toContain("exceeds");
    expect(packet.entries[1]?.missing).toBe(true);
    const rendered = renderExecutionPacket(packet);
    expect(rendered).toContain("repo:sdk/huge.csv");
    expect(rendered).toContain("repo:missing.txt");
  });

  it("reads a small repo: source whole through the bound pipeline", async () => {
    const { repoRoot, section } = repoFixture();
    const { io, reads } = realIo(section, repoRoot);
    const packet = await buildExecutionPacket(["repo:sdk/index.ts"], io);
    expect(packet.entries).toHaveLength(1);
    expect(packet.entries[0]?.path).toBe("repo:sdk/index.ts");
    expect(packet.entries[0]?.sha256).toBe(createHash("sha256").update("export const sdk = 1;\n").digest("hex"));
    expect(packet.entries[0]?.windows[0]?.excerpt).toContain("export const sdk = 1;");
    expect(packet.entries[0]?.missing).toBeUndefined();
    expect(reads[0]).toEqual({ rootPath: repoRoot, path: join(repoRoot, "sdk", "index.ts") });
  });

  it("refuses repo: sources when no repository root is known", async () => {
    const { section } = repoFixture();
    const { io } = realIo(section, null);
    await expect(io.readSlice("repo:sdk/index.ts", 0, 1)).rejects.toThrow("repository root");
    await expect(io.readWhole("repo:notes.txt")).rejects.toThrow("repository root");
    await expect(io.readSlice("notes.txt", 0, 1)).resolves.toMatchObject({ kind: "slice" });
  });

  it("still lets the bounded primitive refuse traversal that bypassed hint validation", async () => {
    const { repoRoot, section } = repoFixture();
    const { io } = realIo(section, repoRoot);
    await expect(io.readSlice("repo:../escape.txt", 0, 1)).rejects.toThrow();
  });
});
