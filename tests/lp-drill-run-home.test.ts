import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The drill scene run_home (docs/task-folder.md «The run folder»): its judges, run on fake checkouts. The live run needs the hub.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

function py(body: string): unknown {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000 });
  expect(res.status, res.stderr).toBe(0);
  const line = res.stdout.trim().split("\n").pop() ?? "";
  return line.startsWith("{") || line.startsWith("[") ? JSON.parse(line) : { stderr: res.stderr };
}

type SceneResult = {
  result: "pass" | "fail";
  problems: string[];
  calls: Array<[string, Record<string, unknown>]>;
  queries: string[];
};

function scene(body: string): SceneResult {
  return py(`
m.log = lambda *a, **k: None
${body}
print(json.dumps(out))
`) as SceneResult;
}

const A = "wfrun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "wfrun_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const put = (cwd: string, path: string) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), "x\n"); };

/** A checkout where each run wrote `.agents/todos/notes/<day>-<run>/note.md` and its manifest lists it; `patch` edits the rows. */
function world(patch: (rows: Array<Record<string, unknown>>, run: string) => Array<Record<string, unknown>> = (rows) => rows) {
  const cwd = mkdtempSync(join(tmpdir(), "lp-drill-run-"));
  for (const run of [A, B]) {
    const path = `.agents/todos/notes/2026-11-14-${run}/note.md`;
    put(cwd, path);
    const rows = patch([{ path, kind: "output", sha256: "s", produced_by: { node: "write" }, plugin_version: "0.1.568" }], run);
    put(cwd, `.agents/runs/${run}/manifest.json`);
    writeFileSync(join(cwd, `.agents/runs/${run}/manifest.json`), JSON.stringify({ schema: "lp.run-manifest/1", run_id: run, workflow_id: "note-add", files: rows }));
  }
  return cwd;
}
const problems = (cwd: string) => py(`print(json.dumps([m.run_manifest_problems(${JSON.stringify(cwd)}, r) for r in (${JSON.stringify(A)}, ${JSON.stringify(B)})]))`) as string[][];
const leaks = (cwd: string, extra: string[]) => py(`print(json.dumps(m.run_shared_leaks(set(), set(${JSON.stringify(extra)}) | m.run_snapshot(${JSON.stringify(cwd)}), [${JSON.stringify(A)}, ${JSON.stringify(B)}], ${JSON.stringify(cwd)})))`) as string[];
const clashes = (cwd: string) => py(`print(json.dumps(m.run_distinct_problems(${JSON.stringify(cwd)}, [${JSON.stringify(A)}, ${JSON.stringify(B)}])))`) as string[];

describe("the drill's run_home scene", () => {
  it("passes two runs whose folders are keyed by the run, whose manifests list files that are on disk, and which leaked nothing", () => {
    const cwd = world();
    expect(problems(cwd)).toEqual([[], []]);
    expect(leaks(cwd, [])).toEqual([]);
    expect(clashes(cwd)).toEqual([]);
  });

  // Mutation each case stands for: a skipped manifest, a listed file that was not written, an output in a shared (not run-keyed) path, a run that
  // replaced another's file, a file nobody's manifest lists.
  it("fails on a missing manifest, a listed file that is not there, a path not keyed by the run, a replaced file and a stray file", () => {
    const none = world();
    expect(py(`print(json.dumps(m.run_manifest_problems(${JSON.stringify(none)}, "wfrun_unknown")))`)).toEqual([expect.stringContaining("no readable")]);
    expect(problems(world((rows) => rows.map((row) => ({ ...row, path: `${row.path}.gone` }))))[0]![0]).toContain("is listed but not on disk");
    const shared = world((rows) => rows.map((row) => ({ ...row, path: ".agents/todos/notes/2026-11-14/note.md" })));
    put(shared, ".agents/todos/notes/2026-11-14/note.md");
    expect(problems(shared)[0]).toContain(`${A}: .agents/todos/notes/2026-11-14/note.md is not in a folder keyed by this run`);
    expect(clashes(shared)).toEqual([expect.stringContaining("was written by both")]);
    expect(clashes(world((rows, run) => rows.map((row) => ({ ...row, replaces: `${run}:x` }))))[0]).toContain("replaced");
    expect(leaks(world(), [".agents/plans/stray.md", `.bb/chats/pm/artifacts/wf-${A.slice(0, 24)}/tasks.1234abcd.json`])).toEqual([".agents/plans/stray.md"]);
    const chat = `.bb/chats/${A}`;
    expect(leaks(world(), [
      `${chat}/thread.json`, `${chat}/README.md`, `${chat}/history/index.json`, `${chat}/history/session/page-00000.json`,
      `${chat}/artifacts/history/note.md`, `${chat}/history-note.md`, ".agents/todos/history/note.md",
    ])).toEqual([".agents/todos/history/note.md", `${chat}/artifacts/history/note.md`, `${chat}/history-note.md`]);
  });

  it("starts through the manual workflow RPC, waits on its returned IDs, and preserves an accepted run when the other start is refused", () => {
    const result = scene(`
import json, tempfile
from pathlib import Path
cwd = tempfile.mkdtemp()
calls, queries = [], []
for run in (${JSON.stringify(A)}, ${JSON.stringify(B)}):
    path = Path(cwd) / ".agents" / "todos" / "notes" / ("2026-11-14-" + run) / "note.md"
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text("x\\n")
    rel = str(path.relative_to(cwd)); manifest = Path(cwd) / ".agents" / "runs" / run / "manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({"schema":"lp.run-manifest/1", "run_id":run, "workflow_id":"note-add", "files":[{"path":rel, "kind":"output", "sha256":"s", "produced_by":{"node":"write"}, "plugin_version":"0.1.568"}]}))
def fake_rpc(method, payload):
    calls.append([method, payload])
    assert method == "workflow_run" and payload["source"] == "manual"
    return {"ok": True, "runId": ${JSON.stringify(A)}} if len(calls) == 1 else {"ok": False, "reason": "no_trigger", "message": "note-add no longer has a schedule trigger"}
def fake_hubsql(sql):
    queries.append(sql)
    return [{"id": ${JSON.stringify(A)}, "status":"succeeded"}]
m.setting_rpc, m.hubsql, m.sandbox_sound = fake_rpc, fake_hubsql, lambda _: []
ctx = type("Ctx", (), {"project":"proj_x", "cwd":cwd})()
out = m.scenario_run_home(ctx)
out = {"result": out["result"], "problems": out["problems"], "calls": calls, "queries": queries}
`);
    expect(result.result).toBe("fail");
    expect(result.problems.join("\\n")).toContain("no_trigger");
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0][0]).toBe("workflow_run");
    expect(result.calls[0][1]).toMatchObject({ id: "note-add", projectId: "proj_x", source: "manual" });
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]).toContain(`id in ('${A}')`);
    expect(result.queries[0]).not.toContain("inputs_json");
  });

  it("does not poll when both manual starts are refused", () => {
    const result = scene(`
calls, queries = [], []
def fake_rpc(method, payload):
    calls.append([method, payload])
    assert method == "workflow_run" and payload["source"] == "manual"
    return {"ok": False, "reason": "no_trigger"}
def fake_hubsql(sql):
    queries.append(sql)
    raise AssertionError("a refused start must not be polled")
m.setting_rpc, m.hubsql, m.run_snapshot, m.sandbox_sound = fake_rpc, fake_hubsql, lambda _: set(), lambda _: []
ctx = type("Ctx", (), {"project":"proj_x", "cwd":"/tmp/not-a-checkout"})()
out = m.scenario_run_home(ctx)
out = {"result": out["result"], "problems": out["problems"], "calls": calls, "queries": queries}
`);
    expect(result.result).toBe("fail");
    expect(result.problems.join("\\n")).toContain("expected two note-add runs");
    expect(result.calls).toHaveLength(2);
    expect(result.queries).toEqual([]);
  });
});
