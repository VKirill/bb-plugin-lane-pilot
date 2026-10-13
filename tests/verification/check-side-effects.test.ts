import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });
import type { DirtSnapshot } from "../../src/rooms/writer/cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, setAttemptWorkspace } from "../../src/rooms/storage/database";
import { createWriterVerify } from "../../src/rooms/writer/server/verify";
import { buildRunPolicy } from "../../src/rooms/tasks/run-policy";
import { undoCheckWrites } from "../../src/rooms/verification/git-ownership";
import { WORKSPACE_DIRT_SCRIPT } from "../../src/rooms/verification/workspace-dirt";

// cakekeeper ck-31-calendar-month-chips (2026-10-12): the task owns the calendar screens, its check
// `next build && screens --grep @clients` rewrote next-env.d.ts and regenerated docs/screens/clients/*.png. The first
// attempt failed its check; the same-thread retry, 23 s later, was rejected «owns_paths rejected
// site/cakekeeper/docs/screens/clients/clients-1440.png» for files Lane Pilot's own check had written.
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const ROOT = "site/cakekeeper";
const CHECK = [
  `printf 'import "./.next/dev/types/routes.d.ts";\\n' > ${ROOT}/apps/web/next-env.d.ts`,
  `printf 'regenerated' > ${ROOT}/docs/screens/clients/clients-1440.png`,
  `printf 'new' > ${ROOT}/docs/screens/clients/reminders-375.png`,
  `printf 'calendar' > ${ROOT}/docs/screens/calendar/month-1440.png`,
  `grep -q chips ${ROOT}/apps/web/src/features/calendar/month.tsx`,
].join(" && ");

async function repoWithWorktree() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "lp-check-effects-")));
  const base = join(root, "cakekeeper.ru");
  const files: Record<string, string> = {
    [`${ROOT}/apps/web/next-env.d.ts`]: 'import "./.next/types/routes.d.ts";\n',
    [`${ROOT}/docs/screens/clients/clients-1440.png`]: "committed",
    [`${ROOT}/apps/web/src/features/calendar/month.tsx`]: "export const Month = 1;\n",
    [`${ROOT}/docs/screens/calendar/week-1440.png`]: "committed",
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(base, rel)), { recursive: true });
    await writeFile(join(base, rel), content);
  }
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  git(base, "add", "-A");
  git(base, "commit", "-qm", "base");
  const worktree = join(root, "lpattempt_cecb", "cakekeeper.ru");
  git(base, "worktree", "add", "-q", "-b", "lane/ck-31", worktree, "HEAD");
  return { base, worktree };
}

const contract = (cwd: string): TaskV2 => ({
  schema_version: 2, id: "ck-31-calendar-month-chips", title: "Calendar month chips", risk: "low", lane: "writer",
  project_cwd: cwd, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: [`${ROOT}/apps/web/src/features/calendar/month.tsx`],
  owns_paths: [`${ROOT}/apps/web/src/features/calendar/`, `${ROOT}/docs/screens/calendar/`],
  never_touch: [`${ROOT}/apps/api/`], depends_on: [], objective: "chips", acceptance: ["chips"], verify: "tests",
  verification: [{ command: CHECK, cwd, timeout_sec: 60 }],
} as unknown as TaskV2);

const config: PrototypeConfig = {
  projectId: "P", hostId: "h", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/pm",
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
};

const dirtOf = (cwd: string) => JSON.parse(execFileSync("python3", ["-c", WORKSPACE_DIRT_SCRIPT], { cwd, encoding: "utf8" })) as DirtSnapshot[];

/** The validate path over real git: the dirt script, the check run by sh, and the host's real undo of check writes. */
function world(base: string, workspace: string) {
  const reverts: string[][] = [];
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: { output: async () => ({ text: "added the chips" }) },
      terminals: {},
      // The check log lands in the task folder, which the repository excludes; nothing else is written here.
      files: { read: async ({ path }: { path: string }) => ({ content: await readFile(path, "utf8").catch(() => null) }),
        write: async () => ({ ok: true }) },
    } as never,
  });
  const db = openDatabase(bb);
  createRun(db, "run-ck", "P", "bb", base);
  createTask(db, { id: "ck-31-calendar-month-chips", runId: "run-ck", kind: "bb", contract: contract(base) });
  const host = { call: async (method: string, input: Record<string, unknown>) => {
    if (method === "runSandboxedCommand") {
      const ran = spawnSync("sh", ["-c", String(input.command)], { cwd: String(input.cwd), encoding: "utf8" });
      return { hostId: "h", exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr, backend: null, policySha256: null, workspacePath: workspace };
    }
    if (method === "gitUndoCheckWrites") {
      const undone = await undoCheckWrites(input as never);
      reverts.push(undone.reverted);
      return { hostId: "h", ...undone };
    }
    if (method === "gitOwnershipBase") return { hostId: "h", status: "not-git", headSha: null, reason: null };
    throw new Error(`unexpected host call ${method}`);
  } };
  const ctx = { bb, db, host, log: () => undefined, runPolicyFor: () => buildRunPolicy({}) };
  const services = {
    runWriterPool: { acquire: async () => () => {} },
    workspaceDirt: async (_config: unknown, cwd: string) => {
      const snapshots = dirtOf(cwd);
      return { ok: true as const, paths: snapshots.map((row) => row.path), snapshots };
    },
  };
  const verify = createWriterVerify(ctx as never, services as never);
  const validate = (attemptId: string, dirtBefore: DirtSnapshot[]) => {
    createAttempt(db, { id: attemptId, runId: "run-ck", taskId: "ck-31-calendar-month-chips" });
    setAttemptWorkspace(db, attemptId, { path: workspace, environmentId: null,
      decision: { strategy: workspace === base ? "inherit_run" : "provision_attempt_worktree", reason: "own_worktree" } });
    return verify.validateWriterResult({ config, projectId: "P", runId: "run-ck", taskId: "ck-31-calendar-month-chips", attempt: 1,
      task: contract(workspace), writerThreadId: "thr_sgtg2yhzy8", attemptId, dirtBefore });
  };
  return { validate, reverts };
}

it("puts back what the checks wrote outside owns_paths, so the same-thread retry is not rejected for it", async () => {
  const { base, worktree } = await repoWithWorktree();
  const { validate, reverts } = world(base, worktree);
  const month = join(worktree, ROOT, "apps/web/src/features/calendar/month.tsx");
  // Attempt 1: the writer's change misses the chips, the check writes its side files and fails.
  await writeFile(month, "export const Month = 2;\n");
  const first = await validate("lpattempt_cecb2751", []);
  expect(first.status).toBe("validation_failed");
  expect(first.reason).toMatch(/^verification failed/);
  expect(reverts.flat().sort()).toEqual([`${ROOT}/apps/web/next-env.d.ts`, `${ROOT}/docs/screens/clients/clients-1440.png`,
    `${ROOT}/docs/screens/clients/reminders-375.png`]);
  // The worktree holds the writer's edit and the owned screenshot, nothing the check wrote elsewhere.
  expect(git(worktree, "status", "--porcelain", "--untracked-files=all").trimEnd().split("\n").sort()).toEqual([
    ` M ${ROOT}/apps/web/src/features/calendar/month.tsx`, `?? ${ROOT}/docs/screens/calendar/month-1440.png`]);
  expect(await readFile(join(worktree, ROOT, "apps/web/next-env.d.ts"), "utf8")).toBe('import "./.next/types/routes.d.ts";\n');

  // Attempt 2, the retry in the same worktree with the first attempt's baseline (no dirt): the writer adds the chips.
  await writeFile(month, "export const Month = 2; // chips\n");
  const retry = await validate("lpattempt_9816f236", []);
  expect(retry.reason ?? "").not.toMatch(/owns_paths rejected|outside owns_paths/);
  expect(retry.status).toBe("accepted");
  // An accepted attempt's `git add -A` would merge what is dirty: only the task's own files are.
  expect(git(worktree, "status", "--porcelain", "--untracked-files=all").trimEnd().split("\n").sort()).toEqual([
    ` M ${ROOT}/apps/web/src/features/calendar/month.tsx`, `?? ${ROOT}/docs/screens/calendar/month-1440.png`]);
});

it("leaves a shared checkout alone: a file there may hold someone else's work", async () => {
  const { base } = await repoWithWorktree();
  const { validate, reverts } = world(base, base);
  await writeFile(join(base, ROOT, "apps/web/src/features/calendar/month.tsx"), "export const Month = 2; // chips\n");
  const result = await validate("lpattempt_inplace", []);
  expect(result.status).toBe("accepted");
  expect(reverts).toEqual([]);
  expect(git(base, "status", "--porcelain")).toContain(`${ROOT}/apps/web/next-env.d.ts`);
});
