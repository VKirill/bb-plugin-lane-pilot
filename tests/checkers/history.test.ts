import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { runScore } from "../../src/rooms/checkers/server/services/score-service";
import { findSolutionCommit, loadCandidates, loadHistory } from "../../src/rooms/checkers/server";
import { createRun, createTask, openDatabase, saveTaskGitBase } from "../../src/rooms/plugin-db";

const localHost = {
  run: (_hostId: string, cwd: string, command: string, timeoutSec = 60) => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 255, stdout, stderr }); });
  }),
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const CODE = `import { LIMIT } from "./limits.mjs";

export function pick(index, size) {
  if (index >= size) return size - 1;
  return index;
}

export function label(count) {
  return count > LIMIT ? "many" : "few";
}
`;
const TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { pick, label } from "./pick.mjs";

test("pick", () => {
  assert.equal(pick(5, 5), 4);
  assert.equal(pick(1, 5), 1);
});

test("label", () => {
  assert.equal(label(9), "many");
});
`;

/** A repository where a task was merged the way Lane Pilot merges it: a merge commit that carries the attempt's trailer. */
function repoWithMergedTask(): { repo: string; contract: Record<string, unknown> } {
  const repo = mkdtempSync(join(tmpdir(), "lp-checkers-hist-"));
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/limits.mjs"), "export const LIMIT = 3;\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-q", "-b", "lane/a1");
  writeFileSync(join(repo, "src/pick.mjs"), CODE);
  writeFileSync(join(repo, "src/pick.test.mjs"), TEST);
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "pick: add pick");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "lane/a1", "-m", "pick: add pick\n\nLane-Pilot-Attempt: a1");
  const contract = {
    schema_version: 2, id: "pick", title: "pick", display_title: "pick", kind: "feature", area: "feature:pick", risk: "medium", lane: "writer", project_cwd: repo,
    read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/pick.mjs"], owns_paths: ["src/pick.mjs", "src/pick.test.mjs"], never_touch: [], depends_on: [],
    objective: "pick", acceptance: ["pick stays inside the list", "label says many above the limit"], verify: "tests",
    verification: [{ command: "node --test src/pick.test.mjs", cwd: repo }],
  };
  return { repo, contract };
}

describe("candidates from the history", () => {
  it("reads what the accepted solution changed and scores planted defects on it with the real checks", async () => {
    const { repo, contract } = repoWithMergedTask();
    const rows = await loadHistory({
      candidates: () => [{ taskId: "pick", projectId: "proj_x", hostId: "local", repoPath: repo, contract }],
      host: localHost, log: () => undefined,
      solutionCommit: async () => ({ commit: git(repo, "rev-parse", "HEAD") }),
      scratch: () => join(repo, "..", `clones-${Date.now()}`),
    }, { limit: 3 });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.input.changes.map((change) => change.path).sort()).toEqual(["src/pick.mjs", "src/pick.test.mjs"]);
    expect(row!.input.changes.every((change) => change.before === null && change.after !== null)).toBe(true);
    expect(row!.where).toEqual({ projectId: "proj_x", hostId: "local", path: repo });

    const report = await runScore({ openVerification: async () => await row!.open() }, { source: "t", candidates: [row!.input], checkers: ["verification", "ownership", "contract_lint", "plan_fact"] });
    const byClass = (name: string, checker: string) => report.rows.find((r) => r.defectClass === name && r.checker === checker)?.outcome;
    // The clean candidate passes its own check in the clone, so what the checks catch is the defect's doing.
    expect(report.rows.filter((r) => r.defectClass === "control" && r.checker === "verification").map((r) => r.outcome)).toEqual(["miss"]);
    expect(byClass("off_by_one", "verification")).toBe("hit");
    expect(byClass("broken_import", "verification")).toBe("hit");
    expect(byClass("outside_owns", "ownership")).toBe("hit");
    expect(byClass("masked_check", "contract_lint")).toBe("hit");
    expect(byClass("test_assertion_deleted", "verification")).toBe("miss");
    expect(report.scorecard.regressions).toEqual([]);
  }, 60_000);

  it("skips a task whose solution cannot be found, and says why", async () => {
    const { repo, contract } = repoWithMergedTask();
    const lines: string[] = [];
    const rows = await loadHistory({
      candidates: () => [{ taskId: "pick", projectId: "proj_x", hostId: "local", repoPath: repo, contract }],
      host: localHost, log: (line) => lines.push(line),
      solutionCommit: async () => ({ reason: "solution_commit_not_found", detail: "no commit" }),
      scratch: () => repo,
    }, { limit: 3 });
    expect(rows).toEqual([]);
    expect(lines.join("\n")).toContain("solution_commit_not_found");
  });

  it("findSolutionCommit locates the merge commit by attempt trailer and falls back to task subject", async () => {
    const { repo } = repoWithMergedTask();
    const head = git(repo, "rev-parse", "HEAD");
    expect(await findSolutionCommit(localHost, { taskId: "pick", attemptId: "a1", hostId: "local", repoPath: repo })).toEqual({ commit: head });
    expect(await findSolutionCommit(localHost, { taskId: "pick", hostId: "local", repoPath: repo })).toEqual({ commit: head });
    expect(await findSolutionCommit(localHost, { taskId: "missing", attemptId: "missing", hostId: "local", repoPath: repo })).toMatchObject({ reason: "solution_commit_not_found" });
  });

  it("loadCandidates selects accepted tasks with valid contracts and records rejection reasons", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const contract = (id: string, overrides: Record<string, unknown> = {}) => ({
      schema_version: 2, id, title: id, display_title: id, kind: "feature", area: "feature:x", risk: "medium", lane: "writer",
      project_cwd: "/repo/app", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.ts"], owns_paths: ["a.ts"],
      never_touch: [], depends_on: [], objective: "x", acceptance: ["ok"], verify: "tests",
      verification: [{ command: "npm test", cwd: "/repo/app" }, { command: "npm run lint", cwd: "/repo/app" }],
      ...overrides,
    });
    const add = (taskId: string, projectId: string, c: Record<string, unknown>) => {
      const runId = `run_${taskId}`;
      createRun(db, runId, projectId, "bb", "/repo/app");
      createTask(db, { id: taskId, runId, kind: "bb", contract: c });
      saveTaskGitBase(db, taskId, { baseRef: "main", baseSha: "a".repeat(40), initialHeadSha: "a".repeat(40), branch: "main", compareCommitted: true });
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(`att_${taskId}`, runId, taskId, null, "accepted", 1, 1000, 2000);
    };
    add("t_ok", "proj_real", contract("t_ok"));
    add("t_sbx", "proj_sbx", contract("t_sbx"));
    add("t_net", "proj_real", contract("t_net", { verification: [{ command: "curl https://example.com", cwd: "/repo/app" }, { command: "npm test", cwd: "/repo/app" }] }));
    add("t_one", "proj_real", contract("t_one", { verification: [{ command: "npm test", cwd: "/repo/app" }] }));

    const result = loadCandidates(db, {
      projectNames: new Map([["proj_real", "App"], ["proj_sbx", "LP sandbox 1"]]),
      isSandboxName: (name) => name.startsWith("LP sandbox"),
      projects: [{ projectId: "proj_real", name: "App", cwdPrefixes: ["/repo/app"] }, { projectId: "proj_sbx", name: "Sandbox", cwdPrefixes: ["/repo/app"] }],
      hostFor: () => "local",
    });
    expect(result.candidates.map((c) => c.taskId)).toEqual(["t_ok"]);
    expect(result.counts).toEqual({ sandbox_project: 1, check_needs_network_or_login: 1, fewer_than_2_checks: 1 });
  });
});
