import type { FailingTest } from "./gate-output";

export type MergedTaskInfo = {
  taskId: string;
  commitSha: string;
  threadId: string | null;
  attemptId: string | null;
  produced: string[];
};

export type GateAttributeResult = {
  /** What each given commit changed, by its first parent: the paths and the workspaces (nearest package.json folders) they lie in. */
  commits: Record<string, { paths: string[]; workspaces: string[] }>;
  /** Per failing test, in the order given: its workspace folder and repository path (null when the host cannot place it), and whether it also fails on the base. */
  failing: Array<{ workspaceDir: string | null; path: string | null; preexisting: boolean | null }>;
  baseline: { status: "ran" | "skipped" | "failed"; reason: string | null };
};

/**
 * Which merged tasks a red gate may be pinned on. A failing test is a task's only when the task's diff touches that test file
 * or the workspace (the nearest package.json folder) it lives in, and only when the test passed on the base the batch started
 * from. Live 2026-10-09 the gate blamed tasks whose diff lay in other packages for failures that were already there.
 */
export type Attribution = {
  /** The host answered: the rule below is strict. Without its answer the caller keeps the older file/import search. */
  strict: boolean;
  /** Failing tests that also fail on the base: nobody in this batch broke them. */
  preexisting: FailingTest[];
  /** The failing tests the batch may have broken. */
  remaining: FailingTest[];
  /** The tasks whose diff touches a remaining test or its workspace. */
  candidates: MergedTaskInfo[];
};

const norm = (path: string) => path.replace(/^\.\//, "").trim();

export const testLabel = (test: FailingTest) => (test.workspacePackage ? `${test.workspacePackage}: ${test.file}` : test.file);

/** Whether one task's diff touches one failing test: the file itself, or any file of its workspace. */
export function taskTouchesTest(task: MergedTaskInfo, test: FailingTest, placed: GateAttributeResult["failing"][number] | undefined, info: GateAttributeResult): boolean {
  const diff = info.commits[task.commitSha];
  // A task the host could not read (no commit, a squashed or unknown sha) is judged by what it declared it produced.
  const paths = (diff?.paths ?? task.produced).map(norm);
  if (placed?.path && paths.includes(placed.path)) return true;
  if (paths.includes(norm(test.file))) return true;
  if (placed?.workspaceDir == null) {
    // The test could not be placed in a workspace: any task that produced a path ending in the file is a suspect.
    return paths.some((path) => path.endsWith(`/${norm(test.file)}`));
  }
  if (diff) return diff.workspaces.includes(placed.workspaceDir);
  const dir = placed.workspaceDir;
  return paths.some((path) => (dir ? path.startsWith(`${dir}/`) : !path.includes("/")));
}

export function attributeFailures(failing: FailingTest[], tasks: MergedTaskInfo[], info: GateAttributeResult | null): Attribution {
  if (!info) return { strict: false, preexisting: [], remaining: failing, candidates: tasks };
  const preexisting = failing.filter((_, index) => info.failing[index]?.preexisting === true);
  const remaining = failing.filter((_, index) => info.failing[index]?.preexisting !== true);
  const candidates = tasks.filter((task) => remaining.some((test) => taskTouchesTest(task, test, info.failing[failing.indexOf(test)], info)));
  return { strict: true, preexisting, remaining, candidates };
}
