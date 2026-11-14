import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";

// The drill's plan_split scene: the contract builders and the pure judge plan_split_problems, run against hand-made rows (no hub).
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("LP_DRILL_")));

function py<T = unknown>(body: string): T {
  const code = `
import importlib.util, json, time
time.strftime = lambda *a: "20261114-000000"  # one STAMP for every process of this file
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ids = m.plan_split_ids()
${body}
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 800));
  return JSON.parse(res.stdout.trim().split("\n").at(-1)!);
}

type Row = Record<string, unknown>;
type Spec = { id: string; objective: string; acceptance: string[]; depends_on: string[]; owns_paths: string[]; expected_outputs: string[]; verification: Array<{ command: string; cwd: string }> };
const ids = py<Record<string, string>>(`print(json.dumps(ids))`);

/** A green diamond: a(1-2), e(1-3), b(3-5), c red (3, blocked) then c.2 (6-8), d(9-11), f(12-13); every base holds its dependencies' merges. */
function green(): Row[] {
  const row = (name: string, state: string, started: number, accepted: number | null, base: string, merge: string | null, changed: string[]): Row => ({
    task_id: ids[name], attempt_id: `att_${name}`, state, reason: null, started, accepted, base_sha: base, merge_commit: merge, changed_json: JSON.stringify(changed),
  });
  return [
    row("a", "accepted", 1, 2, "m0", "ma", ["notes/a.md"]),
    row("e", "accepted", 1, 3, "m0", "me", ["notes/e.md"]),
    row("b", "accepted", 3, 5, "ma", "mb", ["notes/b.md"]),
    row("c", "blocked", 3, null, "ma", null, []),
    row("c2", "accepted", 6, 8, "mb", "mc", ["notes/c.md"]),
    row("d", "accepted", 9, 11, "mc", "md", ["notes/d.md"]),
    row("f", "accepted", 12, 13, "md", "mf", ["notes/f.md"]),
  ];
}
const REASON = `waiting for depends_on: ${ids.b},${ids.c} (${ids.c} ended blocked or canceled; starts once it is sent again and accepted)`;
const REFUSED = `{"state":"validation_failed","findings":[{"code":"depends_cycle","path":"depends_on"}]}`;

/** Runs plan_split_problems; `ancestor` is a fake is_ancestor: "all", "none", or the [merge, base] pairs that hold. */
function judge(rows: Row[], over: { reason?: string; reply?: string; cycleRows?: Row[]; ancestor?: "all" | "none" | string[][] } = {}): string[] {
  const ancestor = over.ancestor ?? "all";
  return py<string[]>(`
rows = json.loads(${JSON.stringify(JSON.stringify(rows))})
ancestor = json.loads(${JSON.stringify(JSON.stringify(ancestor))})
fake = (lambda merge, base: True) if ancestor == "all" else (lambda merge, base: False) if ancestor == "none" else (lambda merge, base: [merge, base] in ancestor)
print(json.dumps(m.plan_split_problems(rows, ids, fake, ${JSON.stringify(over.reason ?? REASON)}, ${JSON.stringify(over.reply ?? REFUSED)}, json.loads(${JSON.stringify(JSON.stringify(over.cycleRows ?? []))}))))
`);
}
const withRow = (rows: Row[], name: string, patch: Row) => rows.map((r) => (r.task_id === ids[name] ? { ...r, ...patch } : r));

describe("plan_split contracts", () => {
  const specs = py<Record<string, Spec>>(`print(json.dumps(m.plan_split_tasks("/sandbox")))`);
  const cycle = py<Record<string, Spec>>(`print(json.dumps(m.plan_split_cycle_tasks("/sandbox")))`);

  it("six valid task documents with the plan's ids and depends_on, c2 being the redispatch id of c", () => {
    expect(Object.keys(specs)).toEqual(["a", "e", "b", "c", "d", "f", "c2"]);
    for (const spec of Object.values(specs)) taskV2Schema.parse(spec);
    expect(ids.c2).toBe(`${ids.c}.2`);
    expect(specs.a.depends_on).toEqual([]);
    expect(specs.e.depends_on).toEqual([]);
    expect(specs.b.depends_on).toEqual([ids.a]);
    expect(specs.c.depends_on).toEqual([ids.a]);
    expect(specs.c2.depends_on).toEqual([ids.a]);
    expect(specs.d.depends_on).toEqual([ids.b, ids.c]);
    expect(specs.f.depends_on).toEqual([ids.d]);
  });

  it("each task owns its own file, no two overlap (c and its redispatch own the same one)", () => {
    const owned = ["a", "b", "c", "d", "e", "f"].flatMap((n) => specs[n].owns_paths as string[]);
    expect(new Set(owned).size).toBe(6);
    expect(specs.c2.owns_paths).toEqual(specs.c.owns_paths);
    for (const spec of Object.values(specs)) expect(spec.expected_outputs.every((p: string) => spec.owns_paths.includes(p))).toBe(true);
  });

  it("every dependent's verification greps its dependencies' files in its own worktree (relative path, cwd .)", () => {
    for (const name of ["b", "c", "c2", "d", "f"]) {
      for (const dep of specs[name].depends_on as string[]) {
        const depName = Object.keys(ids).find((n) => ids[n] === dep)!;
        const depFile = specs[depName].owns_paths[0] as string;
        expect(specs[name].verification.some((v) => v.command.startsWith("grep -qx") && v.command.includes(depFile))).toBe(true);
      }
      for (const v of specs[name].verification) {
        expect(v.cwd).toBe(".");
        expect(v.command).not.toContain("/sandbox");
      }
    }
    expect(specs.d.verification.filter((v) => v.command.startsWith("grep -qx"))).toHaveLength(2);
  });

  it("the first contract of c has a check on a token its objective never mentions; c.2 is the same contract without it", () => {
    const token = py<string>(`print(json.dumps(m.PLAN_SPLIT_RED_TOKEN))`);
    expect(specs.c.verification.some((v) => v.command.includes(token))).toBe(true);
    expect(JSON.stringify([specs.c.objective, specs.c.acceptance])).not.toContain(token);
    expect(JSON.stringify(specs.c2.verification)).not.toContain(token);
    expect(specs.c2.id).toBe(ids.c2);
    expect(specs.c2.objective).toBe(specs.c.objective);
  });

  it("the cycle pair depends on each other", () => {
    expect(cycle.x.depends_on).toEqual([ids.y]);
    expect(cycle.y.depends_on).toEqual([ids.x]);
    taskV2Schema.parse(cycle.x);
    taskV2Schema.parse(cycle.y);
  });

  it("the SQL is one constant with the run placeholder, and a value that is no plain id is refused", () => {
    const out = py<string[]>(`print(json.dumps([m.plan_split_sql(m.PLAN_SPLIT_SQL, run="run_1"), m.PLAN_SPLIT_SQL]))`);
    expect(out[1]).toContain("a.run_id=:run");
    expect(out[0]).toContain("a.run_id='run_1'");
    expect(() => py(`m.plan_split_sql(m.PLAN_SPLIT_SQL, run="x'; drop table y; --")`)).toThrow();
  });
});

describe("plan_split_problems", () => {
  it("a green diamond passes", () => {
    expect(judge(green())).toEqual([]);
  });

  it("d started before c.2 was accepted fails with a named problem", () => {
    expect(judge(withRow(green(), "d", { started: 7 }))).toEqual([expect.stringMatching(/^started_before_dependency_accepted: .*-d-d started at 7/)]);
  });

  it("e started after a was accepted fails: an independent task waited", () => {
    expect(judge(withRow(green(), "e", { started: 2.5 })).some((p) => p.startsWith("independent_waited: "))).toBe(true);
  });

  it("b and c starting before a was accepted fail", () => {
    const out = judge(withRow(withRow(green(), "b", { started: 1.5 }), "c", { started: 1.5 }));
    expect(out.filter((p) => p.startsWith("started_before_dependency_accepted: "))).toHaveLength(2);
  });

  it("an independent accepted only after c.2 fails (it waited for the failure)", () => {
    expect(judge(withRow(green(), "e", { accepted: 9 })).some((p) => p.startsWith("independent_waited_for_failure: "))).toBe(true);
  });

  it("f started before d was accepted fails", () => {
    expect(judge(withRow(green(), "f", { started: 10 })).some((p) => p.startsWith("started_before_dependency_accepted: "))).toBe(true);
  });

  it("a base without the dependency merge fails (fake is_ancestor false)", () => {
    expect(judge(green(), { ancestor: "none" }).filter((p) => p.startsWith("base_lacks_dependency_merge: "))).toHaveLength(5);
    // Every base holds its dependencies' merges except d's base, which lacks the merge of b.
    const holds = [["ma", "ma"], ["ma", "mb"], ["mb", "mc"], ["mc", "md"], ["ma", "mc"], ["md", "md"]].filter(([merge, base]) => !(merge === "mb" && base === "mc"));
    const only = judge(green(), { ancestor: [...holds, ["mc", "mc"], ["md", "md"]] });
    expect(only).toHaveLength(1);
    expect(only[0]).toMatch(/^base_lacks_dependency_merge: .*-d-d was cut from mc.*merge mb.*-d-b$/);
  });

  it("a missing merge commit or base is a named problem, not a pass", () => {
    expect(judge(withRow(green(), "a", { merge_commit: null })).some((p) => p.startsWith("no_merge_commit: "))).toBe(true);
    expect(judge(withRow(green(), "d", { base_sha: null })).some((p) => p.startsWith("no_base_sha: "))).toBe(true);
  });

  it("d that did not name d-c while it was blocked fails", () => {
    expect(judge(green(), { reason: "" })).toEqual([expect.stringMatching(/^dependent_did_not_wait_for_failed: /)]);
    expect(judge(green(), { reason: `waiting for depends_on: ${ids.b}` })).toHaveLength(1);
  });

  it("c accepted the first time fails: the red check was not red", () => {
    expect(judge(withRow(green(), "c", { state: "accepted", accepted: 4 })).some((p) => p.startsWith("c_first_not_blocked: "))).toBe(true);
  });

  it("two tasks changing the same path, and a merge_conflict reason, fail", () => {
    expect(judge(withRow(green(), "f", { changed_json: JSON.stringify(["notes/d.md"]) })).some((p) => p.startsWith("changed_paths_overlap: "))).toBe(true);
    expect(judge(withRow(green(), "b", { reason: "merge_conflict: notes/x.md" })).some((p) => p.startsWith("merge_conflict: "))).toBe(true);
  });

  it("a cycle without a depends_cycle refusal, or with an attempt for d-y, fails", () => {
    expect(judge(green(), { reply: `{"state":"accepted"}` })).toEqual([expect.stringMatching(/^cycle_not_refused: /), expect.stringMatching(/^cycle_not_validation_failed: /)]);
    expect(judge(green(), { reply: "" })).toHaveLength(2);
    expect(judge(green(), { cycleRows: [{ task_id: ids.y, attempt_id: "att_y", state: "queued" }] })).toEqual([expect.stringMatching(/^cycle_attempt_exists: /)]);
  });

  it("a task that never ran is reported missing", () => {
    expect(judge(green().filter((r) => r.task_id !== ids.f)).some((p) => p.startsWith("missing_accepted: "))).toBe(true);
  });
});

describe("plan_split registration", () => {
  // ALL stays main's list (tests/sma/parity-d2-drill-ship-1: the deploy and full drills list what main lists); a new scene runs by
  // name or under --series, like revert.
  it("runs by name and in the task suite, not in --quick, and the scout finds no gaps", () => {
    const out = py<{ all: string[]; extra: string[]; quick: string[]; task: string[]; scout: object; has: boolean; doc: string }>(`print(json.dumps({"all": m.ALL, "extra": m.EXTRA, "quick": m.QUICK, "task": m.SUITES["task"], "scout": m.scout(), "has": callable(m.scenario_plan_split), "doc": m.scenario_plan_split.__doc__}))`);
    expect(out.extra).toContain("plan_split");
    expect(out.all).not.toContain("plan_split");
    const named = spawnSync("python3", ["-I", drill, "--scenario", "plan_split", "--dry-run"], { encoding: "utf8", timeout: 60_000, env: { ...ownEnv, LP_DRILL_SELECT: "0", BB_CLI: "/nonexistent/bb" } });
    expect(named.stdout).toContain("scenario plan_split:");
    expect(out.quick).not.toContain("plan_split");
    expect(out.task).toContain("plan_split");
    expect(out.scout).toMatchObject({ unlisted: [], undefined: [], ungrouped: [], regrouped: [], unknown: [] });
    expect(out.has).toBe(true);
    expect(out.doc).toContain("lane_pilot_attempt_transition");
    const quick = spawnSync("python3", ["-I", drill, "--quick", "--dry-run"], { encoding: "utf8", timeout: 60_000, env: { ...ownEnv, LP_DRILL_SELECT: "0", BB_CLI: "/nonexistent/bb" } });
    expect(quick.stdout).not.toContain("plan_split");
  });
});
