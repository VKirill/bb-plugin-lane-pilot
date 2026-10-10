import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";

// Real repositories and shells: inside Lane Pilot's sandboxed check the whole suite runs ~2.5x slower, and
// vitest's 5 s default would cut these off (2026-10-06 check log, sibling git-integrate/git-lock timeouts).
vi.setConfig({ testTimeout: 120_000 });
import type { DirtSnapshot } from "../../src/rooms/writer/cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, setAttemptWorkspace } from "../../src/rooms/storage/database";
import { createWriterVerify } from "../../src/rooms/writer/server/verify";
import { buildRunPolicy } from "../../src/rooms/tasks/run-policy";
import { appendExcludeCommand, persistTaskFolder, TASK_FOLDER_EXCLUDE } from "../../src/rooms/verification/git-integrate";
import { WORKSPACE_DIRT_SCRIPT } from "../../src/rooms/verification/workspace-dirt";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

/** A repo whose workspace (`sub`) is a subfolder of the checkout, like the project workspace on OVH. */
async function subfolderRepo() {
  const root = await mkdtemp(join(tmpdir(), "lp-subfolder-"));
  const repo = join(root, "site");
  const sub = join(repo, "templates", "blog");
  await mkdir(sub, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(sub, "owned.ts"), "one\n");
  await writeFile(join(repo, "outside.txt"), "untouched\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return { root, repo, sub };
}

/** The workspace's dirt rows as the host reports them: the real dirt script, run in the subfolder workspace. */
function workspaceDirt(sub: string): DirtSnapshot[] {
  return JSON.parse(execFileSync("python3", ["-c", WORKSPACE_DIRT_SCRIPT], { cwd: sub, encoding: "utf8" })) as DirtSnapshot[];
}

const task = (taskId: string, sub: string): TaskV2 => ({
  schema_version: 2, id: taskId, title: "Edit the blog", risk: "low", lane: "writer",
  project_cwd: sub, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["owned.ts"], owns_paths: ["owned.ts"], never_touch: [], depends_on: [],
  objective: "edit owned.ts", acceptance: ["owned.ts changed"], verify: "none", verification: [],
} as unknown as TaskV2);

const config: PrototypeConfig = {
  projectId: "P", hostId: "h", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/pm",
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
};

/**
 * The validate path over a real repo, with every dirt snapshot answered repo-relative — the leak OVH showed
 * (2026-10-06, workspace templates/blog inside the treba-sites checkout). The normalisation inside verify must
 * carry every ownership check on its own; the host is never reached.
 */
async function writerVerify(options: {
  sub: string; taskId: string;
  dirtBefore: DirtSnapshot[]; dirtAfter: DirtSnapshot[];
  fileContents: Record<string, string | null>;
}) {
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: { output: async () => ({ text: "changed owned.ts" }) },
      files: { read: async ({ path }: { path: string }) => {
        for (const [rel, content] of Object.entries(options.fileContents)) {
          if (path === `${options.sub}/${rel}`) return content === null ? { content: null } : { content };
        }
        return { content: null };
      } },
    },
  });
  const db = openDatabase(bb);
  createRun(db, "run-sub", "P", "bb", options.sub);
  createTask(db, { id: options.taskId, runId: "run-sub", kind: "bb", contract: task(options.taskId, options.sub) });
  createAttempt(db, { id: "att-sub", runId: "run-sub", taskId: options.taskId });
  setAttemptWorkspace(db, "att-sub", { path: options.sub, environmentId: null, decision: { strategy: "inherit_run", reason: "subfolder test" } });
  const ctx = {
    bb, db,
    host: { call: async () => { throw new Error("host must not be reached in this test"); } },
    runPolicyFor: () => buildRunPolicy({}),
  };
  const services = {
    runWriterPool: { acquire: async () => () => {} },
    workspaceDirt: async () => ({ ok: true as const, paths: options.dirtAfter.map((row) => row.path), snapshots: options.dirtAfter }),
  };
  return createWriterVerify(ctx as never, services as never).validateWriterResult({
    config, projectId: "P", runId: "run-sub", taskId: options.taskId, attempt: 1,
    task: task(options.taskId, options.sub), writerThreadId: "writer-sub", attemptId: "att-sub",
    dirtBefore: options.dirtBefore,
  });
}

it("writes the task-folder exclude once into the repo's real info/exclude and no .git into a subfolder workspace", async () => {
  const { repo, sub } = await subfolderRepo();
  const write = async (rel: string, content: string) => {
    const path = join(sub, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  };
  const exclude = async (line: string) => { execFileSync("sh", ["-c", appendExcludeCommand(line)], { cwd: sub }); };
  const first = await persistTaskFolder({ taskId: "sub-task-1", plan: "Subfolder plan", exclude, writeFile: write });
  expect(first).toEqual({ folder: ".agents/plans/items/sub-task-1" });
  // A second pass changes nothing: the line stays single.
  await persistTaskFolder({ taskId: "sub-task-1", plan: "Subfolder plan", exclude, writeFile: write });
  const text = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  expect(text.split("\n").filter((line) => line === TASK_FOLDER_EXCLUDE)).toEqual([TASK_FOLDER_EXCLUDE]);
  expect(await readFile(join(sub, ".agents", "plans", "items", "sub-task-1", "PLAN.md"), "utf8")).toBe("Subfolder plan\n");
  expect(existsSync(join(sub, ".git"))).toBe(false);
  expect(git(repo, "status", "--porcelain").trim()).toBe("");
  expect(git(sub, "check-ignore", "-q", ".agents/plans/items/sub-task-1/PLAN.md")).toBe("");
});

it("accepts an owned change while bb chat noise is dirty before and after and unrelated dirt sits outside the workspace", async () => {
  const { repo, sub } = await subfolderRepo();
  await mkdir(join(sub, ".bb", "chats", "thr_before"), { recursive: true });
  await writeFile(join(sub, ".bb", "chats", "thr_before", "README.md"), "chat bookkeeping\n");
  await writeFile(join(repo, "outside.txt"), "dirty before the attempt\n");
  const dirtBefore = workspaceDirt(sub);
  await writeFile(join(sub, "owned.ts"), "two\n");
  await mkdir(join(sub, ".bb", "chats", "thr_after"), { recursive: true });
  await writeFile(join(sub, ".bb", "chats", "thr_after", "history.json"), "[]\n");
  const result = await writerVerify({
    sub, taskId: "sub-task-3", dirtBefore, dirtAfter: workspaceDirt(sub),
    fileContents: { "owned.ts": "two\n" },
  });
  expect(result.status).toBe("accepted");
  expect(result.produced).toContain("owned.ts");
  for (const path of result.produced) {
    expect(path).not.toContain(".bb/");
    expect(path).not.toBe("outside.txt");
    expect(path.startsWith("templates/")).toBe(false);
  }
});

it("ignores unhashable bb bookkeeping in the pre-existing dirt instead of blocking the attempt on it", async () => {
  const { repo, sub } = await subfolderRepo();
  const dirtBefore = workspaceDirt(sub);
  await mkdir(join(sub, ".bb", "chats", "thr_ghost"), { recursive: true });
  await writeFile(join(sub, ".bb", "chats", "thr_ghost", "thread.json"), "{}\n");
  await writeFile(join(sub, "owned.ts"), "two\n");
  // A bookkeeping baseline row with no hash, and the file still there after the attempt.
  const leaked = [...dirtBefore, { path: ".bb/chats/thr_ghost/thread.json", sha256: "" }];
  const result = await writerVerify({
    sub, taskId: "sub-task-4", dirtBefore: leaked, dirtAfter: workspaceDirt(sub),
    fileContents: { "owned.ts": "two\n" },
  });
  expect(result.status).toBe("accepted");
  expect(result.reason ?? "").not.toContain("cannot compare pre-existing dirty file content");
});

it("still rejects a writer change outside owns_paths inside the subfolder, named workspace-relative", async () => {
  const { repo, sub } = await subfolderRepo();
  await mkdir(join(sub, ".bb", "chats", "thr_before"), { recursive: true });
  await writeFile(join(sub, ".bb", "chats", "thr_before", "README.md"), "chat bookkeeping\n");
  await writeFile(join(repo, "outside.txt"), "dirty before the attempt\n");
  const dirtBefore = workspaceDirt(sub);
  await writeFile(join(sub, "owned.ts"), "two\n");
  await writeFile(join(sub, "stray.ts"), "not owned\n");
  const result = await writerVerify({
    sub, taskId: "sub-task-5", dirtBefore, dirtAfter: workspaceDirt(sub),
    fileContents: { "owned.ts": "two\n", "stray.ts": "not owned\n" },
  });
  expect(result.status).toBe("validation_failed");
  expect(result.reason).toContain("stray.ts");
  expect(result.reason).not.toContain("templates/blog/stray.ts");
  expect(result.reason).not.toContain(".bb/");
  expect(result.reason).not.toContain("outside.txt");
});
