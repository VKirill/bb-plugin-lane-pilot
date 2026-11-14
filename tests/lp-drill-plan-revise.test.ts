import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The planner <-> critic loop drill scenes (plan_revise, plan_revise_cap, plan_l): full set only, each sets its own project settings and puts them back.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

/** Runs `body` (python) against the drill module with a fake hub; `rows` holds the project settings (key -> [value, version]). */
type Out = { rows: Record<string, any[]>; calls: string[][]; out: any }; // guardian: allow (JSON out of the python body, shape differs per test)
const J = (value: unknown) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
function py(body: string): Out {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.log = lambda *a, **k: None
rows = {}
calls = []
def fake_rpc(method, payload):
    calls.append([method, payload.get("key") or (payload.get("keys") or [""])[0]])
    key = payload.get("key") or (payload.get("keys") or [""])[0]
    if method == "save_setting":
        value, version = rows.get(key, [None, 0])
        if payload["expectedVersion"] != version:
            return {"ok": False, "conflict": True, "version": version}
        rows[key] = [payload["value"], version + 1]
        return {"ok": True, "version": version + 1}
    if method == "reset_project_settings":
        if key == "owner.words":
            return {"ok": False, "conflict": False}
        rows.pop(key, None)
        return {"ok": True}
    raise AssertionError(method)
def fake_hubsql(sql):
    for key, (value, version) in rows.items():
        if f"key='{key}'" in sql:
            return [{"value": json.dumps(value), "version": version}]
    return []
m.setting_rpc = fake_rpc
m.hubsql = fake_hubsql
class Ctx:
    project = "proj_x"; run_id = "run_x"; pm = "thr_pm"; cwd = "/tmp/x"
ctx = Ctx()
${body}
print(json.dumps({"rows": rows, "calls": calls, "out": out}))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 30_000 });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

describe("the plan loop scenes are in the full set only", () => {
  it("are named, defined, grouped and not in the quick set", () => {
    const { out } = py(`out = {"scout": m.scout(), "quick": m.QUICK, "all": m.ALL}`);
    expect(out.scout).toMatchObject({ unlisted: [], undefined: [], ungrouped: [], regrouped: [], unknown: [] });
    for (const name of ["plan_revise", "plan_revise_cap", "plan_l"]) {
      expect(out.all).toContain(name);
      expect(out.quick).not.toContain(name);
      expect(out.scout.defined).toContain(name);
    }
  });
});

describe("the tasks the scenes dispatch", () => {
  it("plan_revise: the objective states the whole job, only the plan sent with --plan misses the second file", () => {
    const { out } = py(`spec = m.plan_revise_task(ctx)\nout = {"spec": spec, "plan": m.plan_revise_plan(spec)}`);
    const { spec, plan } = out as { spec: Record<string, any>; plan: string }; // guardian: allow (JSON out of the python body)
    expect(spec.expected_outputs).toHaveLength(2);
    for (const path of spec.expected_outputs) expect(spec.owns_paths).toContain(path);
    expect(spec.risk).toBe("high");
    const [first, second] = spec.expected_outputs as string[];
    // The PM's fields ask for both files, each with its heading: nothing in them for the planner to send back to the PM.
    for (const [path, heading] of [[first, "# alpha.md"], [second, "# beta.md"]]) {
      expect(spec.objective).toContain(path);
      expect(spec.objective).toContain(heading);
      expect(spec.acceptance.join(" ")).toContain(path);
      expect(spec.verification[0].command).toContain(path);
    }
    // The plan is the deficient one: a step for the first file only.
    expect(plan).toContain(first);
    expect(plan).not.toContain(second);
    expect(plan).not.toBe(spec.objective);
  });

  it("plan_revise dispatches with its plan; the other two scenes dispatch without one", () => {
    const { out } = py(`
sent = []
class Run(Ctx):
    def dispatch(self, spec, plan=None): sent.append([spec["id"], plan]); return True
    def wait_ended(self, ids): return [{"id": "a", "task_id": ids[0], "state": "accepted", "reason": "", "created_at": 1, "thread_id": None, "workspace_path": None}]
m.plan_loop_evidence = lambda c, t: {"editions": [], "steps": [], "receipts": [{"state": "passed"}]}
run_ctx = Run()
for scene in (m.scenario_plan_revise, m.scenario_plan_revise_cap, m.scenario_plan_l):
    scene(run_ctx)
out = sent`);
    const [revise, cap, l] = out as Array<[string, string | null]>;
    expect(revise[0]).toContain("plan-revise");
    expect(revise[1]).toContain("alpha.md");
    expect(revise[1]).not.toContain("beta.md");
    expect(cap[1]).toBeNull();
    expect(l[1]).toBeNull();
  });

  it("ctx.dispatch passes the plan as --plan after the contract, and nothing without one", () => {
    const { out } = py(`
import lp_drill.context as context_module
seen = []
fake = lambda *args, **kw: (seen.append(list(args)) or (0, "{}", ""))
m.bb = context_module.bb = fake
c = m.Context.__new__(m.Context)
c.project, c.pm, c.dispatches = "proj_x", "thr_pm", {}
c.dispatch({"id": "t1"}, "1. Create a.md")
c.dispatch({"id": "t2"})
out = seen`);
    expect(out[0]).toEqual(["lane-pilot", "dispatch-bb", "proj_x", "thr_pm", '{"id": "t1"}', "--plan", "1. Create a.md"]);
    expect(out[1]).toEqual(["lane-pilot", "dispatch-bb", "proj_x", "thr_pm", '{"id": "t2"}']);
  });

  it("plan_revise_cap: the dispatch lint lets it through, the plan critique finds a structural error the planner may not fix", async () => {
    const { out } = py(`out = m.plan_revise_cap_task(ctx)`);
    const { lintContract } = await import("../src/rooms/tasks/server/contract-lint");
    const { findTaskPlaceholderPaths } = await import("../src/rooms/critique/critique-coverage");
    const { PLAN_FIXABLE_FINDINGS } = await import("../src/rooms/critique/server/critique-runs/plan-critique");
    // The dispatch lint lets it through (no output_unowned, no depends_self / depends_cycle): otherwise the plan critique never runs.
    const lint = lintContract({ task: out as never, workspacePath: out.project_cwd, hostId: "host-1", sandboxUnsafe: [], openTasks: [], deadDependencies: [], kinds: null, runTasks: [] } as never);
    expect(lint.errors).toEqual([]);
    expect(out.depends_on).toEqual([]);
    // The plan critique's structural error is in acceptance, a field the planner may not change.
    expect(findTaskPlaceholderPaths(out)).toEqual(["acceptance[1]"]);
    expect(PLAN_FIXABLE_FINDINGS.has("task_placeholder")).toBe(false);
  });

  it("plan_l: a medium-risk single task with exactly eight owns_paths", () => {
    const { out } = py(`out = m.plan_l_task(ctx)`);
    expect(out.risk).toBe("medium");
    expect(out.owns_paths).toHaveLength(8);
    expect(new Set(out.owns_paths).size).toBe(8);
    expect(out.depends_on).toEqual([]);
  });
});

describe("what each scene asserts", () => {
  const row = (state: string, states: string[], reason = "") => ({ state, states, reason });
  const editions = [{ edition: 1, reason: null }, { edition: 2, reason: "planner_revision:1/3" }];
  const steps = [{ node_id: "plan-critique", state: "succeeded" }, { node_id: "plan-revise", state: "succeeded" }];
  const check = (fn: string, r: unknown, ev: unknown) => py(`out = m.${fn}(${J(r)}, ${J(ev)})`).out as string[];

  it("plan_revise passes on a revision, a passed critique, a landed task and no blocked attempt", () => {
    expect(check("revise_problems", row("accepted", ["accepted"]), { editions, steps, receipts: [{ state: "passed" }] })).toEqual([]);
  });

  it("plan_revise fails without a revision, on a blocked attempt, and on a critique that did not pass", () => {
    const ev = { editions: [{ edition: 1, reason: null }], steps: [], receipts: [{ state: "blocked" }] };
    const problems = check("revise_problems", row("blocked", ["blocked"], "x"), ev).join("\n");
    expect(problems).toContain("no planner_revision edition");
    expect(problems).toContain("no plan-revise step");
    expect(problems).toContain("not passed");
    expect(problems).toContain("went blocked");
  });

  it("plan_revise_cap wants a block on the plan critique and no revision or step", () => {
    const blocked = row("blocked", ["blocked"], "structural_plan_critique_blocked");
    expect(check("cap_problems", blocked, { editions: [], steps: [], receipts: [{ state: "blocked" }] })).toEqual([]);
    expect(check("cap_problems", row("accepted", ["accepted"]), { editions: [], steps: [], receipts: [] }).join()).toContain("not blocked");
    expect(check("cap_problems", row("blocked", ["blocked"], "writer_failed"), { editions: [], steps: [], receipts: [] }).join()).toContain("plan critique");
    const problems = check("cap_problems", blocked, { editions, steps, receipts: [] }).join("\n");
    expect(problems).toContain("planner_revision edition exists");
    expect(problems).toContain("plan-revise step");
  });

  it("plan_l fails a skip below the threshold, accepts a passed or blocked critique", () => {
    const ended = row("accepted", ["accepted"]);
    expect(check("plan_l_problems", ended, { receipts: [{ state: "passed" }] })).toEqual([]);
    expect(check("plan_l_problems", row("blocked", ["blocked"]), { receipts: [{ state: "blocked", reason: "owns_paths" }] })).toEqual([]);
    expect(check("plan_l_problems", ended, { receipts: [{ state: "skipped", reason: "below_critique_threshold" }] }).join()).toContain("skipped");
    expect(check("plan_l_problems", ended, { receipts: [] })).toEqual(["no plan-critique receipt"]);
  });
});

describe("the settings a scene sets are put back", () => {
  it("restores a changed value to the old one and an unset key by a reset, through the body's success", () => {
    const { rows, calls, out } = py(`
rows["plan_critique.enabled"] = [False, 4]
problems = []
with m.scoped_settings(ctx, m.PLAN_REVISE_SETTINGS, problems):
    assert rows["plan_critique.enabled"][0] is True and rows["plan_critique.revise_by"][0] == "planner"
out = problems`);
    expect(out).toEqual([]);
    expect(rows["plan_critique.enabled"][0]).toBe(false);
    expect(rows["plan_critique.revise_by"]).toBeUndefined();
    expect(calls).toContainEqual(["reset_project_settings", "plan_critique.revise_by"]);
  });

  it("restores when the body raises", () => {
    const { rows, out } = py(`
rows["plan_critique.min_owns_paths"] = [0, 2]
problems = []
try:
    with m.scoped_settings(ctx, m.PLAN_L_SETTINGS, problems):
        raise RuntimeError("scene body broke")
except RuntimeError as cause:
    out = [str(cause), problems]`);
    expect(out).toEqual(["scene body broke", []]);
    expect(rows["plan_critique.min_owns_paths"][0]).toBe(0);
    expect(rows["plan_critique.enabled"]).toBeUndefined();
  });

  it("restores the keys already saved when a later save fails, and reports a restore that fails", () => {
    const { rows, out } = py(`
inner = m.setting_rpc
def broken(method, payload):
    if method == "save_setting" and payload["key"] == "plan_critique.revise_by" and payload["value"] == "planner":
        return {"ok": False, "conflict": False}
    return inner(method, payload)
m.setting_rpc = broken
problems = []
try:
    with m.scoped_settings(ctx, m.PLAN_REVISE_SETTINGS, problems):
        pass
except RuntimeError as cause:
    out = [str(cause)[:40], problems]`);
    expect(out[1]).toEqual([]);
    expect(rows["plan_critique.enabled"]).toBeUndefined();
  });

  it("a whole scene dispatches, judges and restores", () => {
    const { rows, out } = py(`
class Run(Ctx):
    def dispatch(self, spec): return True
    def wait_ended(self, ids): return [{"id": "a", "task_id": ids[0], "state": "blocked", "reason": "structural_plan_critique_blocked", "created_at": 1, "thread_id": None, "workspace_path": None}]
run_ctx = Run()
m.plan_loop_evidence = lambda c, t: {"editions": [], "steps": [], "receipts": [{"state": "blocked", "reason": "structural_plan_critique_blocked"}]}
out = m.scenario_plan_revise_cap(run_ctx)`);
    expect(out).toMatchObject({ name: "plan_revise_cap", result: "pass", problems: [] });
    expect(rows["plan_critique.enabled"]).toBeUndefined();
    expect(rows["plan_critique.revise_by"]).toBeUndefined();
  });
});
