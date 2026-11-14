// The task home (docs/task-folder.md) against the daily worktree pass (docs/worktrees.md), on real temp repositories: the pass decides
// every linked copy on the machine and searches the home folder for repositories, yet a task home lives in the base checkout. It must never
// be listed or removed, a worktree holding the task's placed copy must still read as clean (the copy is git-excluded bookkeeping), and after
// the pass removed that worktree the home must still resolve through the manifest.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, createTask, openDatabase } from "../src/rooms/plugin-db";
import { openTaskHome, placeTaskHome, readTaskFile, recordTaskFile, renderTaskManifest, resolveTaskFile, TASK_HOME_EXCLUDE, type TaskFileIo } from "../src/rooms/storage";
import { sweepWorktreeClasses } from "../src/rooms/verification/worktree-sweep";

vi.setConfig({ testTimeout: 120_000 });

const DAY = 86_400_000;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** The machine's files as the task home reads and writes them (the plugin does this through bb files on the task's host). */
const diskIo: TaskFileIo = {
  read: async (path) => existsSync(path) ? readFileSync(path, "utf8") : null,
  write: async (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
};

async function world() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lp-task-home-sweep-")));
  const base = join(dir, "projects", "app");
  mkdirSync(base, { recursive: true });
  git(base, "init", "-q", "-b", "main");
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  writeFileSync(join(base, "a.txt"), "a\n");
  git(base, "add", ".");
  git(base, "commit", "-qm", "init");
  // The dispatch's exclude line of the task homes (dispatch-workflow.ts, TASK_HOME_EXCLUDE): linked worktrees read the common info/exclude.
  appendFileSync(join(base, ".git", "info", "exclude"), `${TASK_HOME_EXCLUDE}\n`);
  const laneRoot = join(dir, ".lane-pilot", "worktrees");
  mkdirSync(laneRoot, { recursive: true });

  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "lprun_s", "proj_s", "bb", base);
  createTask(db, { id: "t1", runId: "lprun_s", kind: "bb", contract: { project_cwd: base } });
  openTaskHome(db, { taskId: "t1", projectId: "proj_s", runId: "lprun_s", basePath: base, hostId: "h1" });
  const record = (kind: Parameters<typeof recordTaskFile>[2]["kind"], name: string, content: string, attemptId?: string) =>
    recordTaskFile(db, diskIo, { taskId: "t1", kind, name, content, producer: { node: kind }, ...(attemptId ? { attemptId } : {}) });
  await record("contract", "contract.v1.json", "{}\n");
  await record("plan", "PLAN.md", "write b.txt\n");

  // The writer's worktree under Lane Pilot's root, with the task's own home placed into it, its work merged into main.
  const wt = join(laneRoot, "app", "lpattempt_t1");
  git(base, "worktree", "add", "-q", "-b", "lane/lpattempt_t1", wt, "HEAD");
  const placed = await placeTaskHome(db, diskIo, diskIo, { taskId: "t1", worktreePath: wt });
  writeFileSync(join(wt, "b.txt"), "b\n");
  git(wt, "add", "b.txt");
  git(wt, "commit", "-qm", "b");
  git(base, "merge", "-q", "--no-ff", "-m", "merge t1", "lane/lpattempt_t1");
  await record("writer-report", "attempts/a1/report.md", "wrote b.txt\n", "a1");
  await record("acceptance", "acceptance.json", "{\"ok\":true}\n", "a1");
  await record("receipt", "receipt.json", "{\"status\":\"accepted\"}\n", "a1");

  const sweep = (dryRun: boolean) => sweepWorktreeClasses({ laneRoot, folders: [base], search: { roots: [dir], maxDepth: 5 }, protectedPaths: new Set(),
    maxAgeMs: 7 * DAY, youngMs: DAY, now: Date.now() + 8 * DAY, dryRun });
  return { dir, base, wt, db, placed, sweep };
}

describe("the daily worktree pass and the task home", () => {
  // Mutations it fails under: the placed home not git-excluded (the worktree reads as dirty and is kept forever); the receipts recorded in the
  // worktree instead of the base home (they go with the worktree); a sweep that decides the base checkout or a folder under .agents/tasks/.
  it("never lists or removes a task home; removes the merged worktree that held its copy; the home still resolves through the manifest after", async () => {
    const { dir, base, wt, db, placed, sweep } = await world();
    expect(placed).toContain(".agents/tasks/t1/PLAN.md");
    expect(existsSync(join(wt, ".agents/tasks/t1/manifest.json"))).toBe(true);

    for (const dryRun of [true, false]) {
      const out = await sweep(dryRun);
      expect(out.errors).toEqual([]);
      // The home search found the project, and nothing it decided is a task home or the base checkout itself.
      expect(out.search).toMatchObject({ roots: [dir], truncated: false });
      expect(out.decisions.map((row) => row.path).filter((path) => path.includes("/.agents/tasks") || path === base)).toEqual([]);
      // The worktree is one decision: merged and clean, so it goes; the placed task-home copy did not count as an uncommitted change.
      expect(out.decisions.map((row) => [row.path, row.cls, row.decision, row.reason])).toEqual([[wt, "lane", "remove", "merged"]]);
    }
    expect(existsSync(wt)).toBe(false);

    // The base home kept every file its manifest lists, and the readers still find them by {task_id, kind}.
    const manifest = renderTaskManifest(db, "t1") as { files: Array<{ path: string; kind: string }> };
    expect(manifest.files.map((row) => row.kind).sort()).toEqual(["acceptance", "contract", "plan", "receipt", "writer-report"]);
    for (const row of manifest.files) expect(existsSync(join(base, ".agents/tasks/t1", row.path)), row.path).toBe(true);
    const acceptance = resolveTaskFile(db, "t1", "acceptance")!;
    expect(acceptance.absPath).toBe(join(base, ".agents/tasks/t1/acceptance.json"));
    expect(readFileSync(acceptance.absPath, "utf8")).toBe("{\"ok\":true}\n");
    const plan = await readTaskFile(db, diskIo, { taskId: "t1", kind: "plan", reader: "after-sweep" });
    expect(plan).toMatchObject({ text: "write b.txt\n", drift: false });
    // The home stays out of git: the merge carried none of it to main.
    expect(git(base, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter((path) => path.startsWith(".agents/"))).toEqual([]);
  });
});
