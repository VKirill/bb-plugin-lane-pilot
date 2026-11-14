import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { wordTurnsOf } from "../src/rooms/phase/logic";

// phase_words_sensitive: owner.words=sensitive, a neutral phase never waits for a word, a plan that touches migrations/ does (full set only).
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

type Out = { rows: Record<string, any[]>; out: any }; // guardian: allow (JSON out of the python body, shape differs per test)
const J = (value: unknown) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
function py(body: string): Out {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.log = lambda *a, **k: None
rows = {}
def fake_rpc(method, payload):
    key = payload.get("key") or (payload.get("keys") or [""])[0]
    if method == "save_setting":
        value, version = rows.get(key, [None, 0])
        if payload["expectedVersion"] != version:
            return {"ok": False, "conflict": True, "version": version}
        rows[key] = [payload["value"], version + 1]
        return {"ok": True, "version": version + 1}
    if method == "reset_project_settings":
        return {"ok": False, "conflict": False}
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
print(json.dumps({"rows": rows, "out": out}))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 30_000 });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

describe("the sensitive phase words drill", () => {
  it("is in the full set, grouped in the phase suite, and not in the quick set", () => {
    const { out } = py(`out = {"scout": m.scout(), "quick": m.QUICK, "all": m.ALL, "phase": m.SUITES["phase"]}`);
    expect(out.scout).toMatchObject({ unlisted: [], undefined: [], ungrouped: [], regrouped: [], unknown: [] });
    expect(out.all).toContain("phase_words_sensitive");
    expect(out.quick).not.toContain("phase_words_sensitive");
    expect(out.phase).toContain("phase_words_sensitive");
  });

  it("the neutral goal names no money, data or deploy path; the migration goal makes the plan create one under migrations/", () => {
    const { out } = py(`
n, g = m.neutral_phase_goal("20260101-000000"), m.migration_phase_goal("20260101-000000")
out = {"n": m.goal_paths(n), "g": m.goal_paths(g), "nSensitive": bool(m.SENSITIVE_PATH.search(n)), "gSensitive": bool(m.SENSITIVE_PATH.search(g)), "gText": g}`);
    expect(out.n.length).toBeGreaterThan(0);
    expect(out.nSensitive).toBe(false);
    expect(out.g.some((p: string) => p.startsWith("migrations/") && p.endsWith(".sql"))).toBe(true);
    expect(out.gSensitive).toBe(true);
    expect(out.gText).toContain("migrations/");
  });

  it("under the plugin's own rule neither goal makes the context ask on sensitive; a piece owning the goal's migrations/ file makes the plan ask with data", () => {
    const { out } = py(`out = {"n": m.neutral_phase_goal("20260101-000000"), "g": m.migration_phase_goal("20260101-000000")}`);
    const settings = { "owner.words": "sensitive" };
    for (const goal of [out.n, out.g]) {
      expect(wordTurnsOf({ title: "Drill words 20260101-000000", goal, record: {} }, settings, 1).context, goal).toMatchObject({ asks: false, classes: [] });
    }
    const piece = (owns: string) => ({ id: "a", wave: 1, task: { title: "the note", objective: out.g, owns_paths: [owns], verification: [{ command: `test -f ${owns}` }] } });
    const migrationFile = (out.g.match(/migrations\/\S+\.sql/) ?? [""])[0];
    const asked = wordTurnsOf({ title: "t", goal: out.g, record: { plan: { items: [piece(migrationFile)] } } as never }, settings, 1);
    expect(asked.planning).toMatchObject({ asks: true, classes: ["data"] });
    const neutralFile = (out.n.match(/drills\/\S+\.md/) ?? [""])[0];
    const quiet = wordTurnsOf({ title: "t", goal: out.n, record: { plan: { items: [{ ...piece(neutralFile), task: { ...piece(neutralFile).task, objective: out.n } }] } } as never }, settings, 1);
    expect(quiet.planning).toMatchObject({ asks: false, classes: [] });
  });

  it("waits for a plan before it judges the planning turn: the turn written at opening from an empty plan is no sign", () => {
    const check = (record: unknown, stage: string) => py(`out = m.plan_decided(${J(record)}, ${J(stage)})`).out as boolean;
    expect(check({ wordTurns: { planning: { asks: false, classes: [], evidence: [] } } }, "discussion")).toBe(false);
    expect(check({ wordTurns: { planning: { asks: false } }, plan: { items: [] } }, "planning")).toBe(false);
    expect(check({ plan: { items: [{ id: "a" }] } }, "planning")).toBe(true);
    expect(check({}, "execution")).toBe(true);
  });

  it("the neutral phase passes with asks false, no word and a stage at execution, and fails otherwise", () => {
    const check = (record: unknown, stage: string) => py(`out = m.neutral_problems(${J(record)}, ${J(stage)})`).out as string[];
    expect(check({ wordTurns: { planning: { asks: false, classes: [], evidence: [] } } }, "execution")).toEqual([]);
    expect(check({ wordTurns: { planning: { asks: true, classes: ["data"], evidence: [] } } }, "planning").join("\n")).toContain("asks is True");
    expect(check({ wordTurns: { planning: { asks: false } }, words: [{ turn: "planning" }] }, "execution").join("\n")).toContain("owner word is recorded");
    expect(check({}, "execution").join("\n")).toContain("wordTurns.planning is missing");
  });

  it("the migration phase passes when it waits at planning with data, and fails on a wrong class, a later stage or a gap without the class", () => {
    const check = (record: unknown, stage: string, gap = "") => py(`out = m.migration_problems(${J(record)}, ${J(stage)}, ${J(gap)})`).out as string[];
    const asks = { wordTurns: { planning: { asks: true, classes: ["data"], evidence: ["migrations/0001_x.sql"] } } };
    expect(check(asks, "planning", "the plan awaits the owner's word: data (migrations/0001_x.sql)")).toEqual([]);
    expect(check(asks, "planning")).toEqual([]);
    expect(check(asks, "execution").join("\n")).toContain("did not stay at planning");
    expect(check({ wordTurns: { planning: { asks: true, classes: ["money"] } } }, "planning").join("\n")).toContain("lacks data");
    expect(check({ wordTurns: { planning: { asks: false, classes: [] } } }, "planning").join("\n")).toContain("not true");
    expect(check(asks, "planning", "the plan awaits the owner's word").join("\n")).toContain("does not name the class");
  });

  it("owner.words is set to sensitive for the body and put back to off (a leftover on counts as off), also when the body raises", () => {
    const first = py(`
rows["owner.words"] = ["on", 3]
problems = []
with m.scoped_settings(ctx, m.WORDS_SETTINGS, problems):
    assert rows["owner.words"][0] == "sensitive"
out = problems`);
    expect(first.out).toEqual([]);
    expect(first.rows["owner.words"][0]).toBe("off");
    const second = py(`
rows["owner.words"] = ["off", 1]
problems = []
try:
    with m.scoped_settings(ctx, m.WORDS_SETTINGS, problems):
        raise ValueError("boom")
except ValueError:
    out = problems`);
    expect(second.out).toEqual([]);
    expect(second.rows["owner.words"][0]).toBe("off");
    const unset = py(`
problems = []
with m.scoped_settings(ctx, m.WORDS_SETTINGS, problems):
    pass
out = problems`);
    expect(unset.out).toEqual([]);
    expect(unset.rows["owner.words"][0]).toBe("off");
  });
});
