import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { stickyTurnPrompt, writerPrompt } from "../src/server/writer-task";
import { classifyWriterOutput, parseGitChangedPaths } from "../src/validate-output";
import { persistTaskFolder, TASK_FOLDER_EXCLUDE, withTaskFolderExclude } from "../src/verification/git-integrate";
import type { TaskV2 } from "../src/contracts";

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

it("writes PLAN.md and puts the exclude line in once", async () => {
  const files = new Map<string, string>([[".git/info/exclude", "# git exclude\n"]]);
  const written = await persistTaskFolder({
    taskId: "lptask_1", plan: "Ship the folder",
    writeFile: async (rel, content) => { files.set(rel, content); },
    readFile: async (rel) => files.get(rel) ?? null,
  });
  expect(written).toEqual({ folder: ".agents/plans/items/lptask_1" });
  expect(files.get(".agents/plans/items/lptask_1/PLAN.md")).toBe("Ship the folder\n");
  expect(files.get(".git/info/exclude")!.split("\n").filter((line) => line === TASK_FOLDER_EXCLUDE)).toEqual([TASK_FOLDER_EXCLUDE]);
  await persistTaskFolder({
    taskId: "lptask_1", plan: "Ship the folder",
    writeFile: async (rel, content) => { files.set(rel, content); },
    readFile: async (rel) => files.get(rel) ?? null,
  });
  expect(files.get(".git/info/exclude")!.split("\n").filter((line) => line === TASK_FOLDER_EXCLUDE)).toEqual([TASK_FOLDER_EXCLUDE]);
  expect(withTaskFolderExclude(files.get(".git/info/exclude")!)).toBe(files.get(".git/info/exclude"));
});

it("writes the task folder onto a real checkout exclude file", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const base = await mkdtemp(join(tmpdir(), "lp-task-folder-"));
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await persistTaskFolder({
    taskId: "abc", plan: "plan text",
    writeFile: async (rel, content) => {
      const path = join(base, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    readFile: async (rel) => readFile(join(base, rel), "utf8").catch(() => null),
  });
  expect(await readFile(join(base, ".agents/plans/items/abc/PLAN.md"), "utf8")).toBe("plan text\n");
  const exclude = await readFile(join(base, ".git/info/exclude"), "utf8");
  expect(exclude.split("\n").filter((line) => line === TASK_FOLDER_EXCLUDE)).toHaveLength(1);
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf8" }).trim()).toBe("");
});
