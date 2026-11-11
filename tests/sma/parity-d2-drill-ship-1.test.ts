import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { pickBatch, batchItemIsFullLane, batchReceiptGaps, type TodoMeta } from "../../src/rooms/backlog/logic";
import { openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { shipWatchSweep } from "../../src/rooms/self-repair/server/ship-watch";

const drill = fileURLToPath(new URL("../../scripts/lp-drill.py", import.meta.url));
const ship = fileURLToPath(new URL("../../scripts/lp-ship.ts", import.meta.url));
const drillSh = fileURLToPath(new URL("../../scripts/lp-drill.sh", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The drill script as `main` has it, copied to a temp file: the reference the defaults are held against. */
function mainDrill(): string {
  const path = join(mkdtempSync(join(tmpdir(), "lp-main-drill-")), "lp-drill.py");
  writeFileSync(path, execFileSync("git", ["-C", repoRoot, "show", "main:scripts/lp-drill.py"], { encoding: "utf8", maxBuffer: 20_000_000 }));
  return path;
}
const dry = (script: string, ...args: string[]) => spawnSync("python3", ["-I", script, ...args, "--dry-run"], { encoding: "utf8", timeout: 60_000 }).stdout.replace(/\d{8}-\d{6}/g, "STAMP");
const dryEnv = (script: string, env: Record<string, string>, ...args: string[]) => spawnSync("python3", ["-I", script, ...args, "--dry-run"], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 }).stdout.replace(/\d{8}-\d{6}/g, "STAMP");

/** Runs `body` (python) against the drill module and prints its result as JSON. */
function drillPy(body: string): unknown {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 800));
  return JSON.parse(res.stdout.trim());
}

const item = (id: string, over: Partial<TodoMeta> = {}): TodoMeta => ({ id, title: id, status: "ready", priority: "medium", estimate: 2, dependsOn: [], created: "2026-01-01", ...over });


describe("defaults: an install that sets nothing new runs the drill exactly as main", () => {
  it("ALL and QUICK are main's lists, and --quick and a plain --dry-run list what main lists", () => {
    const main = mainDrill();
    const lists = (path: string) => { const code = `import importlib.util, json\nspec = importlib.util.spec_from_file_location("d", ${JSON.stringify(path)})\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nprint(json.dumps([m.ALL, m.QUICK]))`; return spawnSync("python3", ["-I", "-c", code], { encoding: "utf8" }).stdout.trim(); };
    expect(lists(drill)).toBe(lists(main));
    // The approve press is on without a switch now: main's output is matched at the opt-out (=0), and unset matches main's =1.
    const off = { LP_DRILL_LIVE_PRESS: "0", BB_SERVER_URL: "" };
    expect(dryEnv(drill, off, "--quick")).toBe(dryEnv(main, off, "--quick"));
    expect(dryEnv(drill, off)).toBe(dryEnv(main, off));
    expect(dryEnv(drill, off, "--scenario", "live_word,no_code_exit")).toBe(dryEnv(main, off, "--scenario", "live_word,no_code_exit"));
    expect(dryEnv(drill, { BB_SERVER_URL: "" }, "--scenario", "live_word")).toBe(dryEnv(main, { LP_DRILL_LIVE_PRESS: "1", BB_SERVER_URL: "" }, "--scenario", "live_word"));
  });

  it("the new scenes run only by name or under --series", () => {
    const out = drillPy(`print(json.dumps({"extra": m.EXTRA, "inAll": [n for n in m.EXTRA if n in m.ALL], "inQuick": [n for n in m.EXTRA if n in m.QUICK]}))`) as { extra: string[]; inAll: string[]; inQuick: string[] };
    expect(out.extra).toEqual(["skills_screen", "revert"]);
    expect(out.inAll).toEqual([]);
    expect(out.inQuick).toEqual([]);
    expect(spawnSync("python3", ["-I", drill, "--scenario", "revert", "--dry-run"], { encoding: "utf8" }).stdout).toContain("scenario revert:");
  });
});

describe("[sma:m_sd_answer] no_code_exit keeps main's one task, and under --series adds an answer-only task and a code task told to change nothing", () => {
  it("lists one task by default and three in a series, with accepted-first-attempt only for the research task", () => {
    const out = drillPy(`
one = m.tasks_no_code_exit("/tmp/x")
three = m.tasks_no_code_exit("/tmp/x", True)
print(json.dumps({"one": [s["kind"] for s in one], "three": [{"id": s["id"], "kind": s["kind"], "objective": s["objective"]} for s in three]}))
`) as { one: string[]; three: Array<{ id: string; kind: string; objective: string }> };
    expect(out.one).toHaveLength(1);
    expect(out.three.map((s) => s.kind)).toEqual(["chore", "research", "fix"]);
    expect(out.three[1]!.objective).toContain("change no file");
    const series = spawnSync("python3", ["-I", drill, "--series", "--scenario", "no_code_exit", "--dry-run"], { encoding: "utf8", timeout: 60_000 });
    expect(series.stdout).toContain("accepted_first_attempt");
    expect(series.stdout).toContain("not_accepted");
    expect(spawnSync("python3", ["-I", drill, "--scenario", "no_code_exit", "--dry-run"], { encoding: "utf8" }).stdout).not.toContain("accepted_first_attempt");
  });

  it("the scenario dispatches one task unless it runs in a series, and judges the answer task only there", () => {
    const run = (series: boolean) => drillPy(`
import os, tempfile
os.environ["LP_DRILL_SERIES"] = ${series ? '"1"' : '"0"'}
sent = []
class Ctx:
    project = "proj_x"; run_id = "run_x"; cwd = tempfile.mkdtemp()
    def dispatch(self, spec): sent.append(spec["id"]); return True
    def wait_ended(self, ids): return []
def summarize(rows, tid, cwd, output=None):
    if "answer" in tid: return {"state": "blocked", "states": ["blocked"], "reason": "nope", "attempts": 2}
    if "human" in tid: return {"state": "blocked", "states": ["blocked"], "reason": "NEEDS_HUMAN: colour"}
    return {"state": "accepted", "states": ["accepted"], "reason": "", "attempts": 1}
m.summarize = summarize
out = m.scenario_no_code_exit(Ctx())
print(json.dumps({"sent": len(sent), "problems": out["problems"]}))
`) as { sent: number; problems: string[] };
    const plain = run(false);
    expect(plain.sent).toBe(1);
    expect(plain.problems).toEqual([]);
    const full = run(true);
    expect(full.sent).toBe(3);
    expect(full.problems.some((line) => line.includes("answer work did not close"))).toBe(true);
    expect(full.problems.some((line) => line.includes("told to change nothing was accepted"))).toBe(true);
  });
});

describe("[sma:m_sd_approve] the press is tied to the drill's own run, and runs unless LP_DRILL_LIVE_PRESS=0", () => {
  const scenario = (live: boolean) => drillPy(`
import os, tempfile, pathlib
os.environ["LP_DRILL_LIVE_PRESS"] = ${live ? '"1"' : '"0"'}
calls, runs, sent = [], [], []
m.owner_words = lambda ctx, v: ("off", 1)
m.restore_owner_words = lambda ctx, o, v: []
m.thread_text = lambda t: "waits for the owner's word before it lands"
m.time.sleep = lambda s: None
m.hubsql = lambda sql: []
m.latest_states = lambda rows: {}
m.summarize = lambda rows, tid, cwd, output=None: {"state": "blocked" if "red" in tid else "accepted", "states": [], "reason": ""}
m.setting_rpc = lambda method, payload: (calls.append(method), {"ok": True})[1]
m.run = lambda args, **k: (runs.append(args), (0, "", ""))[1]
tmp = pathlib.Path(tempfile.mkdtemp())
class Ctx:
    project = "proj_x"; run_id = "run_abc"; pm = "thr"; cwd = str(tmp); tmp = tmp
    def dispatch(self, spec): sent.append(spec["id"]); return True
    def wait_ended(self, ids): return []
    def rows(self, ids): return []
out = m.scenario_live_word(Ctx())
scene = json.loads(next(tmp.glob("approve-*.json")).read_text()) if runs else None
print(json.dumps({"result": out["result"], "problems": out["problems"], "calls": calls, "pressed": len(runs), "sent": len(sent), "scene": scene}))
`) as { result: string; problems: string[]; calls: string[]; pressed: number; sent: number; scene: { steps: Array<{ click?: string }> } | null };

  it("with LP_DRILL_LIVE_PRESS=0 the word goes through the RPC as on main: no window, one task", () => {
    const out = scenario(false);
    expect(out.pressed).toBe(0);
    expect(out.calls).toEqual(["task_word"]);
    expect(out.sent).toBe(1);
    expect(out.result).toBe("pass");
  });

  it("with LP_DRILL_LIVE_PRESS=1 the scene opens the owner board and clicks only this run's yes button", () => {
    const out = scenario(true);
    expect(out.pressed).toBe(1);
    expect(out.sent).toBe(2);
    const clicks = out.scene!.steps.map((step) => step.click).filter(Boolean);
    expect(clicks[0]).toBe('[data-testid="scope-nav-waiting"]');
    expect(clicks[1]).toBe('[data-testid^="owner-run-task-word:run_abc:"][data-testid$="-yes"]');
  });
});

describe("[sma:m_sd_merge] the revert is judged by the merged revert receipt, not by the word «revert»", () => {
  it("revert_merged wants a receipt of kind revert in state merged", () => {
    const out = drillPy(`
f = lambda receipts: m.revert_merged(json.dumps({"taskId": "t", "attempts": [], "receipts": receipts, "summary": "revert is mentioned here"}))
print(json.dumps({
  "merged": f([{"kind": "revert", "state": "merged", "resultCommit": "abc"}]),
  "dry": f([{"kind": "revert", "state": "dry_run"}]),
  "refused": f([{"kind": "revert", "state": "refused", "summary": "revert refused"}]),
  "reverify": f([{"kind": "reverify", "state": "merged"}]),
  "none": f([]),
  "garbage": m.revert_merged("revert revert revert"),
}))
`) as Record<string, boolean>;
    expect(out).toEqual({ merged: true, dry: false, refused: false, reverify: false, none: false, garbage: false });
  });

  it("revert_judged asks `changes` without --json (the verb takes no flags) and reports a missing receipt, markers and a leftover note", () => {
    const out = drillPy(`
seen = []
m.bb = lambda *a, **k: (seen.append(list(a)), (0, json.dumps({"receipts": [{"kind": "revert", "state": "dry_run"}]}), ""))[1]
m.sandbox_sound = lambda cwd: []
import os
os.makedirs("/tmp/drillx2", exist_ok=True)
open("/tmp/drillx2/note.md","w").write("<<<<<<< ours\\n")
m.POLL_SEC = 0
clock = [m.time.time()]
m.time.time = lambda: (clock.__setitem__(0, clock[0] + 400), clock[0])[1]
class Ctx: project = "proj_x"; cwd = "/tmp/drillx2"
problems = m.revert_judged(Ctx(), "t", "note.md")
m.bb = lambda *a, **k: (0, json.dumps({"receipts": [{"kind": "revert", "state": "merged"}]}), "")
os.remove("/tmp/drillx2/note.md")
print(json.dumps({"problems": problems, "args": seen[0], "ok": m.revert_judged(Ctx(), "t", "note.md")}))
`) as { problems: string[]; args: string[]; ok: string[] };
    expect(out.args).toEqual(["lane-pilot", "changes", "t"]);
    expect(out.problems.some((line) => line.includes("merge receipt"))).toBe(true);
    expect(out.problems.some((line) => line.includes("conflict markers"))).toBe(true);
    expect(out.problems.some((line) => line.includes("still on main"))).toBe(true);
    expect(out.ok).toEqual([]);
  });
});

describe("[sma:m_sd_skills] the skills screen opens the drill's own project by URL, restores what it pressed, and compares with <", () => {
  const view = (names: string[] | null, value: unknown, version: number) => ({ catalog: { skills: [{ name: "a" }, { name: "b" }] }, roles: [{ role: "pm", key: "access_pm", version, value, groups: { skills: { names } } }] });
  const scenario = (url: string | null, views: unknown[]) => drillPy(`
import os, tempfile, pathlib
for k in ("LP_DRILL_UI_ACCESS_URL", "LP_DRILL_UI_URL", "BB_SERVER_URL"): os.environ.pop(k, None)
if ${url ? "True" : "False"}: os.environ["LP_DRILL_UI_ACCESS_URL"] = ${JSON.stringify(url ?? "")}
views = json.loads(${JSON.stringify(JSON.stringify(views))})
calls, runs, saved = [], [], []
def rpc(method, payload):
    calls.append(method)
    if method == "helper_access_view": return views.pop(0) if len(views) > 1 else views[0]
    saved.append(payload); return {"ok": True}
m.setting_rpc = rpc
m.run = lambda args, **k: (runs.append(args), (0, "", ""))[1]
tmp = pathlib.Path(tempfile.mkdtemp())
class Ctx: project = "proj_sb"; cwd = str(tmp); tmp = tmp
out = m.scenario_skills_screen(Ctx())
scene = json.loads(next(tmp.glob("skills-*.json")).read_text()) if runs else None
print(json.dumps({"out": out, "calls": calls, "pressed": len(runs), "saved": saved, "scene": scene}))
`) as { out: { result: string; problems: string[]; note?: string }; calls: string[]; pressed: number; saved: Array<{ keys?: string[]; key?: string }>; scene: { url: string } | null };

  it("without an address env the page is derived from the window's own address and the press runs on it", () => {
    const out = scenario(null, [view(null, null, 0), view(["a"], { skills: ["a"] }, 1)]);
    expect(out.pressed).toBe(1);
    expect(out.scene!.url).toBe("http://127.0.0.1:4173/plugins/lane-pilot/lane-pilot/proj_sb/access");
    expect(out.calls).toContain("helper_access_view");
  });

  it("with the address it presses on that project's page, then puts the access row back (a row that did not exist is removed)", () => {
    const out = scenario("http://127.0.0.1:4173/p/{project}/access", [view(null, null, 0), view(["a"], { skills: ["a"] }, 1)]);
    expect(out.pressed).toBe(1);
    expect(out.scene!.url).toBe("http://127.0.0.1:4173/p/proj_sb/access");
    expect(out.out.problems).toEqual([]);
    expect(out.calls).toContain("reset_project_settings");
    expect(out.saved[0]!.keys).toEqual(["access_pm"]);
  });

  it("a press that changes nothing the roles load is a problem (< not <=)", () => {
    const out = scenario("http://x/{project}", [view(null, null, 0), view(null, null, 0)]);
    expect(out.out.result).toBe("fail");
    expect(out.out.problems.some((line) => line.includes("no change"))).toBe(true);
  });

  it("the judge flags a changed file hash and a blank window", () => {
    const out = drillPy(`
print(json.dumps({
  "changed": m.skills_screen_problems({"door": {"catalog": 3, "narrowed": True}, "window": {"listed": True}, "diskBefore": {"a": "1"}, "diskAfter": {"a": "2"}}),
  "blank": m.skills_screen_problems({"door": {"catalog": 3, "narrowed": True}, "window": {}, "diskBefore": {}, "diskAfter": {}}),
  "ok": m.skills_screen_problems({"door": {"catalog": 3, "narrowed": True}, "window": {"listed": True}, "diskBefore": {"a": "1"}, "diskAfter": {"a": "1"}}),
}))
`) as { changed: string[]; blank: string[]; ok: string[] };
    expect(out.changed.some((line) => line.includes("skill files changed"))).toBe(true);
    expect(out.blank.some((line) => line.includes("neither skills nor the empty-list"))).toBe(true);
    expect(out.ok).toEqual([]);
  });
});

describe("[sma:rl_prep] a series with an unready part does not start", () => {
  const prep = (hostListed: boolean, limitsError: boolean, dbDown: boolean) => drillPy(`
import tempfile, os
os.environ["LP_DRILL_RECEIPT_DIR"] = tempfile.mkdtemp()
def hub(sql):
    if ${dbDown ? "True" : "False"}: raise RuntimeError("ssh down")
    return []
m.hubsql = hub
m.git = lambda cwd, *a: "" if "status" in a else "deadbeef"
m.run = lambda args, **k: (0, "[]", "")
m.bb = lambda *a, **k: (0, ${hostListed ? 'json.dumps([{"id": "host_7sea4qaad8"}])' : '"[]"'}, "")
def rpc(method, payload):
    if ${limitsError ? "True" : "False"}: raise RuntimeError("cockpit down")
    return {}
m.setting_rpc = rpc
p = m.series_preparation()
print(json.dumps({"checks": {c["name"]: c["ok"] for c in p["checks"]}, "problems": p["problems"]}))
`) as { checks: Record<string, boolean>; problems: string[] };

  it("each probed part can fail on its own: a dead database, a host that is not listed, an unreadable limits window", () => {
    const down = prep(true, false, true);
    expect(down.checks.database).toBe(false);
    expect(down.problems.some((line) => line.startsWith("database:"))).toBe(true);
    const unready = prep(false, true, false);
    expect(Object.keys(unready.checks)).toEqual(["database", "receipts", "browser", "limits", "window"]);
    expect(unready.checks.window).toBe(false);
    expect(unready.checks.limits).toBe(false);
    expect(unready.problems.some((line) => line.startsWith("window:"))).toBe(true);
    expect(unready.problems.some((line) => line.startsWith("limits:"))).toBe(true);
  });

  it("everything answering leaves no problem", () => {
    expect(prep(true, false, false).problems).toEqual([]);
  });
});

describe("[sma:rl_suites] every scenario sits in exactly one named suite", () => {
  it("scout reports no ungrouped, no regrouped, no unknown, the extra scenes are known, and the suite keys equal the nine card names", () => {
    const out = drillPy(`print(json.dumps(m.scout()))`) as { ungrouped: string[]; regrouped: string[]; unknown: string[]; unlisted: string[]; undefined: string[]; suites: Record<string, string[]>; empty: string[] };
    expect(Object.keys(out.suites)).toEqual(["task", "batch", "phase", "release", "window", "worker", "lockstep", "wiring", "metrics"]);
    expect(out.ungrouped).toEqual([]);
    expect(out.regrouped).toEqual([]);
    expect(out.unknown).toEqual([]);
    expect(out.unlisted).toEqual([]);
    expect(out.undefined).toEqual([]);
    expect(out.empty).toEqual([]);
  });

  it("--suite runs as a series: it is accepted, and an unknown suite is refused", () => {
    const run = spawnSync("python3", ["-I", drill, "--suite", "window", "--dry-run"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("vitest:tests/release-stories-window.test.tsx");
    expect(spawnSync("python3", ["-I", drill, "--suite", "nope", "--dry-run"], { encoding: "utf8" }).status).toBe(2);
  });
});

describe("[sma:rl_metrics] the metrics suite runs last and can fail a series", () => {
  const metrics = (scenes: string) => drillPy(`
import pathlib, tempfile
m.setting_rpc = lambda method, payload: {}
r = m.series_metrics(${scenes}, pathlib.Path(tempfile.mkdtemp()))
print(json.dumps({"verdict": r["verdict"], "problems": r["problems"], "last": list(m.SUITES)[-1]}))
`) as { verdict: string; problems: string[]; last: string };

  it("a drill scene without evidence fails; a clean list passes; metrics is the last suite", () => {
    const red = metrics(`[{"name": "a", "exit": 0, "receipt": None}]`);
    expect(red.verdict).toBe("fail");
    expect(red.problems.some((line) => line.includes("no readable receipt"))).toBe(true);
    expect(red.last).toBe("metrics");
    expect(metrics("[]").verdict).toBe("pass");
  });

  it("a vitest scene is judged by its exit code alone", () => {
    expect(metrics(`[{"name": "vitest:tests/x.test.ts", "suite": "window", "exit": 0, "receipt": None}]`)).toMatchObject({ verdict: "pass", problems: [] });
    const failed = metrics(`[{"name": "vitest:tests/x.test.ts", "suite": "window", "exit": 1, "receipt": None}]`);
    expect(failed.verdict).toBe("fail");
    expect(failed.problems).toEqual(["scene vitest:tests/x.test.ts exited 1"]);
  });
});

describe("[sma:k_lib_releaselint] lp-drill.sh calls predict-lint on --series and --quick, never on a plain run", () => {
  function runSh(...args: string[]) {
    const bin = mkdtempSync(join(tmpdir(), "lp-fakebin-"));
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "npx $@" >> ${log}\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, "python3"), `#!/bin/sh\necho "python3 $@" >> ${log}\necho RECEIPT=/tmp/x.json\nexit 0\n`, { mode: 0o755 });
    const res = spawnSync("bash", [drillSh, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return { status: res.status, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  }

  it("a plain run goes straight to the drill; --quick and --series lint first and stop on a finding", () => {
    for (const args of [[], ["--scenario", "parallel3"]]) {
      const res = runSh(...args);
      expect(res.calls).not.toContain("predict-lint");
      expect(res.calls).toContain("python3");
      expect(res.status).toBe(0);
    }
    for (const args of [["--quick"], ["--series"]]) {
      const res = runSh(...args);
      expect(res.calls).toContain("predict-lint");
      expect(res.calls).not.toContain("python3");
      expect(res.status).toBe(1);
    }
    expect(runSh("--quick", "--dry-run").calls).not.toContain("predict-lint");
    expect(runSh("--series", "--dry-run").calls).not.toContain("predict-lint");
  });
});

describe("[sma:k_v_shiplane] lane drafts and keeps one record per base/head; --no-record prints main's four fields and writes nothing; --record is accepted as a no-op", () => {
  it("a temp repo with two commits", () => {
    const repo = mkdtempSync(join(tmpdir(), "lp-lane-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1\n");
    git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first");
    git("tag", "v0.1.0");
    writeFileSync(join(repo, "b.txt"), "2\n");
    git("add", "."); git("commit", "-qm", "second");
    writeFileSync(join(repo, "c.txt"), "3\n");
    git("add", "."); git("commit", "-qm", "third");
    const plain = spawnSync("npx", ["tsx", ship, "lane", "v0.1.0", "--cwd", repo, "--no-record"], { encoding: "utf8", timeout: 120_000 });
    expect(plain.status).toBe(0);
    expect(Object.keys(JSON.parse(plain.stdout))).toEqual(["base", "files", "lane", "why"]);
    expect(existsSync(join(repo, ".agents/ship/lanes.jsonl"))).toBe(false);
    // Unset (no flag): recording is the default.
    const first = spawnSync("npx", ["tsx", ship, "lane", "v0.1.0", "--cwd", repo], { encoding: "utf8", timeout: 120_000 });
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout) as { changelogDraft: string; record: string };
    expect(out.changelogDraft.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
    // --record is still accepted and changes nothing.
    const second = spawnSync("npx", ["tsx", ship, "lane", "v0.1.0", "--cwd", repo, "--record"], { encoding: "utf8", timeout: 120_000 });
    expect((JSON.parse(second.stdout) as { record: string }).record).toBe("already recorded");
    expect(readFileSync(join(repo, ".agents/ship/lanes.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("[sma:k_v_batch] a board of five issuable items, two dependent, yields at most four with no dependent pair", () => {
  it("pickBatch caps at four, drops big estimates and dependent pairs", () => {
    const items = [item("a"), item("b"), item("c"), item("d"), item("e"), item("big", { estimate: 9 }), item("dep", { dependsOn: ["a"] })];
    const batch = pickBatch(items as TodoMeta[], 4);
    expect(batch.length).toBeLessThanOrEqual(4);
    expect(batch.length).toBeGreaterThanOrEqual(2);
    expect(batch.map((i) => i.id)).not.toContain("big");
    expect(batch.map((i) => i.id)).not.toContain("dep");
    expect(pickBatch([item("a")] as TodoMeta[])).toHaveLength(1);
  });
});

describe("[sma:k_v_batch/k_lib_batch] the middle lane filters by risk and demands receipts", () => {
  it("a core-path item goes to the full lane; an item without a plan-critique receipt is named", () => {
    expect(batchItemIsFullLane(item("x", { ownsPaths: ["src/rooms/storage/db.ts"] }))).toBe(true);
    expect(batchItemIsFullLane(item("x", { ownsPaths: ["docs/a.md"] }))).toBe(false);
    expect(batchReceiptGaps({ state: "accepted", stages: [{ id: "plan-critique", state: "passed" }] })).toEqual([]);
    expect(batchReceiptGaps({ state: "accepted", stages: [] })).toContain("plan-critique receipt");
    expect(batchReceiptGaps({ state: "blocked", stages: [{ id: "plan-critique", state: "passed" }] })).toContain("accepted attempt receipt");
  });
});


describe("[sma:k_lib_pkgcheck] publishable called the old way does not ask for builds or a test receipt; --strict does", () => {
  // Three `lp-ship` processes one after another: 18 s on a loaded machine (the full run, a deploy), 4 s alone.
  it("the receipt finding appears only with --strict", { timeout: 60_000 }, () => {
    const receipts = mkdtempSync(join(tmpdir(), "lp-receipts-"));
    const env = { ...process.env, LP_TEST_RECEIPTS: receipts };
    const plain = spawnSync("npx", ["tsx", ship, "publishable"], { encoding: "utf8", timeout: 240_000, env, cwd: repoRoot });
    expect(plain.stdout).not.toContain("test-full receipt");
    expect(plain.stdout).not.toContain("is not built");
    const strict = spawnSync("npx", ["tsx", ship, "publishable", "--strict"], { encoding: "utf8", timeout: 240_000, env, cwd: repoRoot });
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("no test-full receipt");
  });
});

describe("[sma:k_lib_docaudit] doc-audit called the old way writes no baseline file", () => {
  it("the verb runs and leaves .agents/ship/doc-coverage-baseline.json alone", () => {
    const baseline = join(repoRoot, ".agents/ship/doc-coverage-baseline.json");
    const existed = existsSync(baseline);
    spawnSync("npx", ["tsx", ship, "doc-audit"], { encoding: "utf8", timeout: 240_000, cwd: repoRoot });
    expect(existsSync(baseline)).toBe(existed);
    const text = readFileSync(ship, "utf8");
    expect(text).toContain('args.includes("--strict")');
  });
});

describe("[sma:k_lib_spafresh] a source touched after the bundle fails freshness --strict; the old way keeps main's exit", () => {
  it("names the stale file only under --strict", () => {
    const dist = join(repoRoot, "dist");
    const made = !existsSync(dist);
    mkdirSync(dist, { recursive: true });
    const bundle = join(dist, "app.js");
    const bundleExisted = existsSync(bundle);
    try {
      if (!bundleExisted) writeFileSync(bundle, "// test bundle\n");
      const old = new Date("2001-01-01T00:00:00Z");
      utimesSync(bundle, old, old);
      const strict = spawnSync("npx", ["tsx", ship, "freshness", "--strict"], { encoding: "utf8", timeout: 120_000, cwd: repoRoot });
      expect(strict.status).toBe(1);
      expect(strict.stdout).toContain("bundle older than sources");
      const plain = spawnSync("npx", ["tsx", ship, "freshness"], { encoding: "utf8", timeout: 120_000, cwd: repoRoot });
      expect(plain.stdout).not.toContain("bundle older than sources");
      expect([0, 1, 2]).toContain(plain.status);
    } finally {
      if (!bundleExisted) rmSync(bundle, { force: true });
      if (made) rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("[sma:k_lib_shiplane] watch on 30 commits since the tag exits 1; with 3 it exits 0", () => {
  it("the watch command counts commits and days over ship.max_batch_*", () => {
    const repo = mkdtempSync(join(tmpdir(), "lp-watch-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    for (let i = 0; i < 30; i++) { writeFileSync(join(repo, `f${i}`), "x"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `c${i}`); }
    git("tag", "v0.1.0");
    for (let i = 0; i < 30; i++) { writeFileSync(join(repo, `g${i}`), "x"); git("add", "."); git("commit", "-qm", `d${i}`); }
    const red = spawnSync("npx", ["tsx", ship, "watch", repo], { encoding: "utf8", timeout: 120_000, cwd: repo });
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("30 commits");
    execFileSync("git", ["-C", repo, "tag", "v0.2.0"]);
    writeFileSync(join(repo, "h"), "x"); git("add", ".");  git("commit", "-qm", "e");
    const green = spawnSync("npx", ["tsx", ship, "watch", repo], { encoding: "utf8", timeout: 120_000, cwd: repo });
    expect(green.status).toBe(0);
  });
});

describe("[sma:k_lib_shiplane/job] the daily ship-watch acts except where ship.watch is off, skips an untagged checkout, survives a bad value, and closes by exact key", () => {
  const commits = (repo: string, n: number) => { for (let i = 0; i < n; i++) execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", `c${i}`]); };
  const checkout = (tagged: boolean) => {
    const repo = mkdtempSync(join(tmpdir(), "lp-sweep-"));
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    commits(repo, 1);
    if (tagged) execFileSync("git", ["-C", repo, "tag", "v0.1.0"]);
    commits(repo, 30);
    return repo;
  };
  const config = (projectId: string, path: string) => ({ projectId, hostId: "host-test", pmWorkspacePath: path, writerWorkspacePath: path, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" });

  // The plugin asks the project's own machine (a host call); here the machine is this one.
  const calls: Array<{ hostId: string; cwd: string }> = [];
  const run = async (at: { hostId: string; cwd: string }, command: string) => {
    calls.push(at);
    try { return { exitCode: 0, stdout: execFileSync("/bin/bash", ["-c", command], { cwd: at.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) }; }
    catch (cause) { return { exitCode: (cause as { status?: number }).status ?? 1, stdout: "" }; }
  };

  it("posts nothing with ship.watch off; with it on, only tagged checkouts over the cap, and proj_1 never closes proj_10", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const repos = { proj_1: checkout(true), proj_10: checkout(true), proj_2: checkout(false), proj_3: checkout(true), proj_4: checkout(true) };
    for (const [id, path] of Object.entries(repos)) savePrototypeConfig(db, config(id, path));
    const open = () => (db.prepare("SELECT key FROM lane_pilot_owner_item WHERE state='open' ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);

    // Switched off everywhere: every checkout is over the cap, nothing is posted and no machine is asked.
    for (const id of Object.keys(repos)) saveProjectSetting(db as never, id, "ship.watch", "off");
    calls.length = 0;
    expect(await shipWatchSweep(db as never, run)).toEqual({ checked: 0, flagged: [] });
    expect(open()).toEqual([]);
    expect(calls).toEqual([]);

    // proj_3 carries an unreadable row (its sweep step is skipped, the others still run), proj_2 has no tag, proj_10 stays off.
    for (const id of ["proj_1", "proj_2", "proj_3", "proj_4"]) saveProjectSetting(db as never, id, "ship.watch", "on");
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES ('proj_3','','ship.max_batch_commits','{bad',1,0)").run();
    const swept = await shipWatchSweep(db as never, run);
    expect(swept.flagged.sort()).toEqual(["proj_1", "proj_4"]);
    expect(open()).toEqual(["ship-watch:proj_1:", "ship-watch:proj_4:"]);

    // proj_10 on and over: two items; the pile of proj_1 falls and only its own item closes.
    saveProjectSetting(db as never, "proj_10", "ship.watch", "on");
    await shipWatchSweep(db as never, run);
    expect(open()).toContain("ship-watch:proj_10:");
    execFileSync("git", ["-C", repos.proj_1, "tag", "v0.2.0"]);
    await shipWatchSweep(db as never, run);
    expect(open()).toEqual(["ship-watch:proj_10:", "ship-watch:proj_4:"]);
  });

  it("ship.watch unset (the default) is on: every tagged checkout over the cap is flagged, an untagged one is skipped", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const repos = { proj_1: checkout(true), proj_2: checkout(false), proj_3: checkout(true) };
    for (const [id, path] of Object.entries(repos)) savePrototypeConfig(db, config(id, path));
    calls.length = 0;
    const swept = await shipWatchSweep(db as never, run);
    expect(swept.checked).toBe(2);
    expect(swept.flagged.sort()).toEqual(["proj_1", "proj_3"]);
    expect(calls.map((call) => call.cwd).sort()).toEqual([repos.proj_1, repos.proj_2, repos.proj_3].sort());
    const open = (db.prepare("SELECT key FROM lane_pilot_owner_item WHERE state='open' ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);
    expect(open).toEqual(["ship-watch:proj_1:", "ship-watch:proj_3:"]);
  });

  it("the pile is counted on the project's own machine, in its checkout", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const repo = checkout(true);
    savePrototypeConfig(db, config("proj_6", repo));
    saveProjectSetting(db as never, "proj_6", "ship.watch", "on");
    calls.length = 0;
    expect((await shipWatchSweep(db as never, run)).flagged).toEqual(["proj_6"]);
    expect(calls).toEqual([{ hostId: "host-test", cwd: repo }]);
    // A machine that does not answer is no pile: nothing is posted for it and the sweep goes on.
    expect(await shipWatchSweep(db as never, async () => { throw new Error("host offline"); })).toEqual({ checked: 0, flagged: [] });
  });

  it("only the word off turns ship.watch off; any other value is the default, on", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const repo = checkout(true);
    savePrototypeConfig(db, config("proj_5", repo));
    saveProjectSetting(db as never, "proj_5", "ship.watch", "off");
    expect((await shipWatchSweep(db as never, run)).flagged).toEqual([]);
    for (const value of ["true", 1, "maybe"]) {
      saveProjectSetting(db as never, "proj_5", "ship.watch", value);
      expect((await shipWatchSweep(db as never, run)).flagged).toEqual(["proj_5"]);
    }
  });
});

describe("[sma:rl_stories] a worker cannot accept its own work", () => {
  it("the story files exist and exercise the real handlers and transitions", () => {
    expect(existsSyncSafe(fileURLToPath(new URL("../release-stories-window.test.tsx", import.meta.url)))).toBe(true);
    expect(existsSyncSafe(fileURLToPath(new URL("../release-stories-worker.test.ts", import.meta.url)))).toBe(true);
  });
});

function existsSyncSafe(path: string) {
  return spawnSync("test", ["-f", path]).status === 0;
}
