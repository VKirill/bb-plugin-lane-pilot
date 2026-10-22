import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScore } from "../../src/rooms/checkers/service";
import { loadHistory } from "../../src/rooms/checkers/history";
import { git, localHost } from "../bench/helpers";

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
});
