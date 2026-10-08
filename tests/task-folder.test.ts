import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

// The real-checkout test below spawns git and sh; inside the sandboxed check the suite runs ~2.5x slower and
// vitest's 5 s default would cut it off (2026-10-06 check log, sibling git-integrate/git-lock timeouts).
vi.setConfig({ testTimeout: 120_000 });
import { stickyTurnPrompt, writerPrompt } from "../src/rooms/writer/server/writer-task";
import { classifyWriterOutput, parseGitChangedPaths } from "../src/rooms/tasks/validate-output";
import { appendExcludeCommand, persistTaskFolder, TASK_FOLDER_EXCLUDE } from "../src/rooms/verification/git-integrate";
import type { TaskV2 } from "../src/rooms/contracts";

const task = {
  id: "t1",
  title: "x",
  objective: "do x",
  project_cwd: "/tmp/w",
  owns_paths: ["src/a.ts"],
  never_touch: [],
  expected_outputs: ["src/a.ts"],
  verify: "none",
  verification: [],
  read_first: [],
} as unknown as TaskV2;

it("keeps the compact contract inline and only adds the folder block when the folder exists", () => {
  const without = writerPrompt(task);
  const stickyWithout = stickyTurnPrompt({ kind: "next-task", task });
  expect(without).not.toContain(".agents/plans/items/");
  expect(stickyWithout).not.toContain(".agents/plans/items/");
  expect(without).toContain('"objective": "do x"');
  const folder = { path: ".agents/plans/items/t1/", files: ["PLAN.md"] };
  const withFolder = writerPrompt(task, "", "", undefined, "Lane Pilot writer", "", "", "", folder);
  const sticky = stickyTurnPrompt({ kind: "retry", task, taskFolder: folder });
  expect(withFolder).toContain(".agents/plans/items/t1/");
  expect(withFolder).toContain("- PLAN.md");
  expect(withFolder).toContain('"objective": "do x"');
  expect(sticky).toContain(".agents/plans/items/t1/");
  expect(sticky).toContain("- PLAN.md");
  expect(sticky).toContain('"objective": "do x"');
});

it("does not treat task-folder files as produced, stray, or owns_paths violations", () => {
  expect(parseGitChangedPaths("?? .agents/plans/items/t1/PLAN.md\n M src/a.ts\n")).toEqual(["src/a.ts"]);
  expect(classifyWriterOutput({
    task, produced: [".agents/plans/items/t1/PLAN.md", "src/a.ts"], contents: { "src/a.ts": "x\n" },
  })).toEqual({ ok: true });
  expect(classifyWriterOutput({
    task, produced: [".agents/plans/items/t1/PLAN.md"], contents: {},
  })).toMatchObject({ ok: false, state: "empty_output" });
});

it("writes PLAN.md and hands the exclude line to the workspace's host", async () => {
  const files = new Map<string, string>();
  const lines: string[] = [];
  const written = await persistTaskFolder({
    taskId: "lptask_1", plan: "Ship the folder",
    exclude: async (line) => { lines.push(line); },
    writeFile: async (rel, content) => { files.set(rel, content); },
  });
  expect(written).toEqual({ folder: ".agents/plans/items/lptask_1" });
  expect(lines).toEqual([TASK_FOLDER_EXCLUDE]);
  expect(files.get(".agents/plans/items/lptask_1/PLAN.md")).toBe("Ship the folder\n");
});

it("still writes PLAN.md when the exclude line cannot reach the repo", async () => {
  const files = new Map<string, string>();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => { warnings.push(String(line)); };
  try {
    const written = await persistTaskFolder({
      taskId: "lptask_1", plan: "Ship the folder",
      exclude: async () => { throw new Error("git dir unresolved"); },
      writeFile: async (rel, content) => { files.set(rel, content); },
    });
    expect(written).toEqual({ folder: ".agents/plans/items/lptask_1" });
  } finally { console.warn = warn; }
  expect(files.get(".agents/plans/items/lptask_1/PLAN.md")).toBe("Ship the folder\n");
  expect(warnings.join("\n")).toContain("task-folder exclude");
});

it("writes the task folder onto a real checkout exclude file, once", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const base = await mkdtemp(join(tmpdir(), "lp-task-folder-"));
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  const write = async (rel: string, content: string) => {
    const path = join(base, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const exclude = async (line: string) => { execFileSync("sh", ["-c", appendExcludeCommand(line)], { cwd: base }); };
  await persistTaskFolder({ taskId: "abc", plan: "plan text", exclude, writeFile: write });
  await persistTaskFolder({ taskId: "abc", plan: "plan text", exclude, writeFile: write });
  expect(await readFile(join(base, ".agents/plans/items/abc/PLAN.md"), "utf8")).toBe("plan text\n");
  const excludeText = await readFile(join(base, ".git/info/exclude"), "utf8");
  expect(excludeText.split("\n").filter((line) => line === TASK_FOLDER_EXCLUDE)).toHaveLength(1);
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf8" }).trim()).toBe("");
});
