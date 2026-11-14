import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";
import { TASK_FILE_KINDS } from "../src/rooms/storage";

// The drill scene task_home (audit handoff-map §5.6; docs/task-folder.md): its judges, run on fake checkouts. The live run needs the hub.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

function py(body: string): { out: unknown; stderr: string } {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000 });
  const line = res.stdout.trim().split("\n").pop() ?? "";
  return { out: line.startsWith("{") || line.startsWith("[") ? JSON.parse(line) : null, stderr: res.stderr };
}

const EXPECTED = ["contract", "plan", "plan-source", "plan-critique", "brief", "writer-report", "checks", "plan-fact", "barrier-input", "code-critique", "acceptance", "receipt", "outcome", "lesson"];

/** A checkout whose task home holds a file per kind and a manifest listing them; `patch` mutates the rows before writing. */
function home(taskId: string, patch: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>> = (rows) => rows, manifest: Record<string, unknown> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "lp-drill-home-"));
  const dir = join(cwd, ".agents/tasks", taskId);
  const rows = patch(EXPECTED.map((kind) => ({ kind, path: `${kind}.md`, read_by: ["plan", "writer-report", "acceptance"].includes(kind) ? [{ node: "x", at: 1, sha256: "s" }] : [] })));
  for (const row of rows) { const file = join(dir, String(row.path)); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "x\n"); }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: "lp.task-manifest/1", task_id: taskId, files: rows, legacy: [], ...manifest }));
  return cwd;
}

const problems = (cwd: string, taskId: string) => py(`print(json.dumps(m.manifest_problems(${JSON.stringify(cwd)}, ${JSON.stringify(taskId)})))`).out as string[];

describe("the drill's task_home scene", () => {
  it("[sma:ap_run_dir] passes a home whose manifest lists every expected kind, each file present and the resolver-read kinds read", () => {
    expect(problems(home("t1"), "t1")).toEqual([]);
  });

  it("expects only kinds the plugin knows, and every main-path kind the audit names", () => {
    const { out } = py("print(json.dumps(list(m.EXPECTED_KINDS)))");
    expect(out).toEqual(EXPECTED);
    for (const kind of out as string[]) expect(TASK_FILE_KINDS).toContain(kind);
  });

  // Mutation of the producer each case stands for: a skipped manifest row, a wrong kind, the file missing after the worktree went,
  // a manifest of another task, a read that bypassed the resolver, a legacy read in a homed task.
  it("fails on a skipped row, a wrong kind, a missing file, another task's manifest, an unread plan and a legacy read", () => {
    expect(problems(home("t1", (rows) => rows.filter((row) => row.kind !== "plan-source")), "t1")).toEqual([expect.stringContaining("lists no plan-source")]);
    expect(problems(home("t1", (rows) => rows.map((row) => row.kind === "writer-report" ? { ...row, kind: "brief" } : row)), "t1").join("\n")).toContain("lists no writer-report");
    const gone = home("t1");
    writeFileSync(join(gone, ".agents/tasks/t1/manifest.json"), JSON.stringify({ schema: "lp.task-manifest/1", task_id: "t1", legacy: [],
      files: EXPECTED.map((kind) => ({ kind, path: kind === "acceptance" ? "attempts/a1/acceptance.json" : `${kind}.md`, read_by: [{ node: "x" }] })) }));
    expect(problems(gone, "t1")).toEqual([expect.stringContaining("attempts/a1/acceptance.json (acceptance) is listed but not in the home")]);
    expect(problems(home("t1", (rows) => rows, { task_id: "t2" }), "t1")).toEqual([expect.stringContaining("not lp.task-manifest/1 of this task")]);
    expect(problems(home("t1", (rows) => rows.map((row) => row.kind === "plan" ? { ...row, read_by: [] } : row)), "t1")).toEqual([expect.stringContaining("no node read its plan")]);
    expect(problems(home("t1", (rows) => rows, { legacy: [{ path: ".agents/plans/items/t1/PLAN.md", reads: 1 }] }), "t1")).toEqual([expect.stringContaining("read old-layout files")]);
    expect(problems(mkdtempSync(join(tmpdir(), "lp-drill-nohome-")), "t1")).toEqual([expect.stringContaining("no readable .agents/tasks/t1/manifest.json")]);
  });

  it("finds every new file in the shared plan, planning and run-artifact folders, and a chat file naming the task, from two find snapshots", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lp-drill-shared-"));
    const put = (rel: string) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), "x\n"); };
    put(".agents/plans/x.md");
    put(".bb/chats/thr_pm/artifacts/old.md");
    const { out } = py(`
before = m.snapshot(${JSON.stringify(cwd)})
from pathlib import Path
root = Path(${JSON.stringify(cwd)})
for rel in [".agents/plans/items/t1/PLAN.md", ".agents/planning/STATE2.md", ".agents/runs/lprun_r/artifacts/t1/acceptance.json", ".agents/runs/lprun_other/state.json",
            ".bb/chats/thr_pm/artifacts/t1-note.md", ".bb/chats/thr_pm/artifacts/pm-own.md", ".agents/tasks/t1/PLAN.md"]:
    (root / rel).parent.mkdir(parents=True, exist_ok=True); (root / rel).write_text("x")
after = m.snapshot(${JSON.stringify(cwd)})
print(json.dumps({"before": sorted(before), "leaks": m.shared_leaks(before, after, ["t1"], "lprun_r")}))`);
    expect((out as { before: string[] }).before).toEqual([".agents/plans/x.md", ".bb/chats/thr_pm/artifacts/old.md"]);
    expect((out as { leaks: string[] }).leaks).toEqual([".agents/planning/STATE2.md", ".agents/plans/items/t1/PLAN.md", ".agents/runs/lprun_r/artifacts/t1/acceptance.json", ".bb/chats/thr_pm/artifacts/t1-note.md"]);
  });

  it("[sma:wi_grant] fails when a worktree on disk holds the neighbour's home", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lp-drill-main-"));
    spawnSync("git", ["init", "-q", cwd]);
    const wt = mkdtempSync(join(tmpdir(), "lp-drill-wt-"));
    mkdirSync(join(wt, ".agents/tasks/t2"), { recursive: true });
    const rows = [{ task_id: "t1", workspace_path: wt }, { task_id: "t2", workspace_path: "/gone" }];
    const { out } = py(`print(json.dumps(m.neighbour_problems(${JSON.stringify(cwd)}, ${JSON.stringify(rows)}, ["t1", "t2"])))`);
    expect(out).toEqual(["the worktree of t1 holds the home of t2"]);
  });

  // Framework 2 (docs/sma-evidence.md): the scene proves a map node only by its own prove() line. A complete home proves the seven nodes it
  // observes; each producer mutation turns its node's ok false: an attempt file outside attempts/<id>/ (n233), no plan-source (n236), the
  // worktree left on disk (n294), no brief (n397), a shared-folder leak (n405), no OUTCOME (n1616), a row without sha256 (n1691).
  it("[sma:k_v_manifest] proves n233, n236, n294, n397, n405, n1616, n1691 on a complete home and refuses each when its producer is mutated", () => {
    const attempt = new Set(["writer-report", "checks", "barrier-input", "code-critique"]);
    const sound = (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ ...row, sha256: "s", produced_by: { node: "n" },
      ...(attempt.has(String(row.kind)) ? { attempt_id: "a1", path: `attempts/a1/${row.kind}.md` } : {}) }));
    const build = (patch: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>> = (rows) => rows) => {
      const cwd = home("t1", (rows) => patch(sound(rows)));
      spawnSync("git", ["init", "-q", cwd]);
      writeFileSync(join(cwd, ".agents/tasks/t1/plan-source.md"), "---\nsources:\n  - source_path: .agents/plans/shared.md\n    sha256: abc\n---\n");
      return cwd;
    };
    const proofs = (cwd: string, opts: { worktree?: string; leaks?: string[] } = {}) => {
      const rows = [{ task_id: "t1", workspace_path: opts.worktree ?? "/gone/wt-t1" }];
      const { out, stderr } = py(`print(json.dumps({n: ok for n, ok, _ in m.node_proofs(${JSON.stringify(cwd)}, ["t1"], ${JSON.stringify(rows)}, ${JSON.stringify(opts.leaks ?? [])}, ".agents/plans/shared.md")}))`);
      expect(stderr).toBe("");
      return out as Record<string, boolean>;
    };
    const all = { n233: true, n236: true, n294: true, n397: true, n405: true, n1616: true, n1691: true };
    expect(proofs(build())).toEqual(all);
    expect(proofs(build((rows) => rows.map((row) => row.kind === "checks" ? { ...row, path: "checks.md" } : row)))).toEqual({ ...all, n233: false });
    const noSource = build();
    writeFileSync(join(noSource, ".agents/tasks/t1/plan-source.md"), "plan text only\n");
    expect(proofs(noSource)).toEqual({ ...all, n236: false });
    expect(proofs(build(), { worktree: mkdtempSync(join(tmpdir(), "lp-drill-left-")) })).toEqual({ ...all, n294: false });
    expect(proofs(build((rows) => rows.filter((row) => row.kind !== "brief")))).toEqual({ ...all, n397: false });
    expect(proofs(build(), { leaks: [".agents/plans/items/t1/PLAN.md"] })).toEqual({ ...all, n405: false });
    expect(proofs(build((rows) => rows.filter((row) => row.kind !== "outcome")))).toEqual({ ...all, n1616: false });
    expect(proofs(build((rows) => rows.map((row) => row.kind === "lesson" ? { ...row, sha256: "" } : row)))).toEqual({ ...all, n1691: false });
  });

  it("runs by name or in the series task suite, and dispatches two valid task-v2 documents whose plan names a shared .agents/plans file, so their homes snapshot it", () => {
    const { out } = py(`print(json.dumps({"specs": m.task_home_specs("/srv/sandbox"), "plan": m.shared_plan("/srv/sandbox")[0], "all": "task_home" in m.ALL, "extra": "task_home" in m.EXTRA, "series": "task_home" in m.SUITES["task"], "quick": "task_home" in m.QUICK}))`);
    const result = out as { specs: unknown[]; plan: string; all: boolean; extra: boolean; series: boolean; quick: boolean };
    // A new scene runs by name or in the release series (suite task), never in the deploy drill or a plain run (the drill-defaults rule, tests/sma/parity-d2-drill-ship-1.test.ts).
    expect(result).toMatchObject({ all: false, extra: true, series: true });
    expect(result.quick).toBe(false);
    expect(result.plan).toMatch(/^\.agents\/plans\/drill-.+-shared\.md$/);
    const specs = result.specs.map((spec) => taskV2Schema.parse(spec));
    expect(specs).toHaveLength(2);
    expect(new Set(specs.map((spec) => spec.id)).size).toBe(2);
    for (const spec of specs) expect(spec.objective).toContain(result.plan);
  });
});
