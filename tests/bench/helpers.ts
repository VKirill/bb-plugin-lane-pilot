import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, createTask, openDatabase, saveTaskGitBase } from "../../src/rooms/storage/database";
import type { ExecResult, HostPort } from "../../src/rooms/bench/ports";

/** A HostPort that runs the command in this machine's shell: the warm-up and the checkout are tested on real git repositories. */
export const localHost: HostPort = {
  run: (_hostId, cwd, command, timeoutSec = 60) => new Promise<ExecResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 255, stdout, stderr }); });
  }),
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** A repository with a base commit and, for each given file, a feature commit merged the way Lane Pilot merges: a merge commit carrying the attempt's trailer. */
export function makeRepo(features: ReadonlyArray<{ file: string; attemptId: string; taskId: string }>): { repo: string; base: string; bases: string[] } {
  const repo = mkdtempSync(join(tmpdir(), "lp-bench-repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const bases: string[] = [];
  for (const feature of features) {
    bases.push(git(repo, "rev-parse", "HEAD"));
    git(repo, "checkout", "-q", "-b", `lane/${feature.attemptId}`);
    writeFileSync(join(repo, feature.file), "done\n");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", `${feature.taskId}: add ${feature.file}`);
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", `lane/${feature.attemptId}`, "-m", `${feature.taskId}: add ${feature.file}\n\nLane-Pilot-Attempt: ${feature.attemptId}`);
  }
  return { repo, base, bases };
}

export function makeContract(repo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2, id: "x", title: "t", display_title: "t", kind: "feature", area: "page:/x", risk: "medium", lane: "writer", project_cwd: repo,
    read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"], owns_paths: ["a.txt"], never_touch: [], depends_on: [],
    objective: "make a.txt", acceptance: ["a.txt exists"], verify: "tests",
    verification: [{ command: "test -f a.txt", cwd: repo }, { command: "grep -q done a.txt", cwd: repo }],
    ...overrides,
  };
}

/** The plugin database with the tables the bench reads, and a helper that writes one accepted task the way the pipeline leaves it. */
export function benchWorld() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  let runs = 0;
  const accepted = (input: { taskId: string; projectId: string; contract: Record<string, unknown>; base: string; attemptId: string; attemptNo?: number }) => {
    const runId = `run_${++runs}`;
    createRun(db, runId, input.projectId, "bb", "/repo");
    createTask(db, { id: input.taskId, runId, kind: "bb", contract: input.contract });
    saveTaskGitBase(db, input.taskId, { baseRef: "main", baseSha: input.base, initialHeadSha: input.base, branch: "main", compareCommitted: true });
    const no = input.attemptNo ?? 1;
    for (let n = 1; n <= no; n++) {
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(n === no ? input.attemptId : `${input.attemptId}_f${n}`, runId, input.taskId, null, n === no ? "accepted" : "validation_failed", n, 1000 + n, 2000 + n);
    }
  };
  return { bb, db, accepted };
}

export const tmp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); mkdirSync(dir, { recursive: true }); return dir; };
