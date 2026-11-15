import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";

const script = fileURLToPath(new URL("../scripts/lp-drill.sh", import.meta.url));
// The drill's own settings (LP_DRILL_*) are left out: a deploy exports them for its sandbox (OVH's since 2026-10-28), and these runs check the defaults.
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("LP_DRILL_")));

describe("scripts/lp-drill.sh (E3)", () => {
  it("--dry-run prints three valid, non-overlapping task-v2 documents and touches nothing", () => {
    const run = spawnSync("bash", [script, "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    expect(run.status).toBe(0);
    const tasks = run.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => taskV2Schema.parse(JSON.parse(line)));
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(3);
    expect(tasks.every((task) => task.risk === "high" && ["none", "smoke", "tests"].includes(task.verify))).toBe(true);
    const owned = tasks.flatMap((task) => task.owns_paths);
    expect(new Set(owned).size).toBe(owned.length);
    for (const task of tasks) expect(task.expected_outputs.every((path) => task.owns_paths.includes(path))).toBe(true);
    expect(tasks[0]!.project_cwd).toBe("/Users/vechkasov/lp-sandbox-rules");
  });

  it("--dry-run also prints a valid task for every other scenario, each in the project folder it runs in", () => {
    const run = spawnSync("bash", [script, "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    const lines = run.stdout.split("\n").filter((line) => line.startsWith("scenario "));
    const byScenario = new Map<string, ReturnType<typeof taskV2Schema.parse>[]>();
    for (const line of lines) {
      const [, name, json] = /^scenario (\w+): (\{.*\})$/.exec(line)!;
      byScenario.set(name!, [...(byScenario.get(name!) ?? []), taskV2Schema.parse(JSON.parse(json!))]);
    }
    expect([...byScenario.keys()]).toEqual(["memory_paths", "conflict", "main_moved", "provider", "provider_limit", "reload", "nogit", "nogit_repo"]);
    expect(byScenario.get("conflict")).toHaveLength(2);
    const [x, y] = byScenario.get("conflict")!;
    expect(x!.owns_paths).toEqual(y!.owns_paths);
    expect(byScenario.get("nogit")![0]!.project_cwd).toBe("/Users/vechkasov/lp-sandbox-layouts/n-nogit");
    // Written from the folder without git; Lane Pilot moves it into the repository repo-a inside it.
    expect(byScenario.get("nogit_repo")![0]).toMatchObject({ project_cwd: "/Users/vechkasov/lp-sandbox-layouts/n-nogit", owns_paths: [expect.stringMatching(/^repo-a\/notes\//)] });
    for (const tasks of byScenario.values()) for (const task of tasks) expect(task.expected_outputs.every((path) => task.owns_paths.includes(path))).toBe(true);
  });

  it("--quick is the guard hash check, the register of deferrals, the checker drill, the memory paths, the helper per provider and the three-task scenario, and an unknown scenario is refused", () => {
    // LP_DRILL_SELECT=0: the whole --quick set, not the selection by what changed since the hub last saw each scenario pass.
    const quick = spawnSync("bash", [script, "--quick", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb", LP_DRILL_SELECT: "0" } });
    expect(quick.status).toBe(0);
    expect(quick.stdout).toContain("scenarios: guard_hash, deferrals, checkers, memory_paths, helper_providers, parallel3");
    expect(quick.stdout).not.toContain("scenario conflict");
    const unknown = spawnSync("bash", [script, "--scenario", "nope", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: ownEnv });
    expect(unknown.status).toBe(2);
  });

  it("the drill lock of a process that is gone is taken over; a live process keeps it (a deploy stops the previous drill mid-run)", () => {
    const code = String.raw`
import importlib.util, json, os, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
lock = Path(tempfile.mkdtemp()) / "lp-drill.lock"
out = []
lock.mkdir()                                   # a lock from before the pid file: nobody to ask, stale
out.append(d.take_lock(lock))
(lock / "pid").write_text("999999999")        # a process that does not exist
out.append(d.take_lock(lock))
out.append((lock / "pid").read_text() == str(os.getpid()))
(lock / "pid").write_text(str(os.getppid()))  # a live process holds it
out.append(d.take_lock(lock))
print(json.dumps(out))
`;
    const run = spawnSync("python3", ["-I", "-c", code, fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url))], { encoding: "utf8", timeout: 30_000, env: ownEnv });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual([true, true, true, false]);
  });

  it("helper_providers: a provider that started and was refused by its quota is a note, not a red; red when no provider answered or when a start failed", () => {
    const code = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
ok = {"provider": "claude-code", "model": "m", "ok": True, "started": True, "answered": True, "reason": None}
quota = {"provider": "opencode2", "model": "z", "ok": False, "started": True, "answered": False, "reason": "helper_probe_timeout:error:provider_error:Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-01 18:30:52"}
dead = {"provider": "codex", "model": "g", "ok": False, "started": False, "answered": False, "reason": "thread_command_failed"}
print(json.dumps([d.helper_problems([ok, quota]), d.helper_problems([quota]), d.helper_problems([ok, dead])]))
`;
    const run = spawnSync("python3", ["-I", "-c", code, fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url))], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    expect(run.status, run.stderr).toBe(0);
    const [withOk, alone, withDead] = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Array<[string[], string[]]>;
    expect(withOk[0]).toEqual([]);
    expect(withOk[1]).toEqual(["opencode2 (z): helper_probe_timeout:error:provider_error:Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-01 18:30:52"]);
    expect(alone[0]).toHaveLength(1);
    expect(alone[0][0]).toMatch(/no provider answered/);
    expect(withDead[0]).toEqual(["codex (g): a helper did not start: thread_command_failed"]);
    expect(withDead[1]).toEqual([]);
  });

  it("--quick leaves out a live scenario whose code did not change since it passed within a day, and runs it otherwise", () => {
    const code = String.raw`
import importlib.util, json, sys, tempfile, time, pathlib
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
reads = {p: [n for n in d.LIVE if d.live_reads(n, p)] for p in ["src/rooms/phase/server/driver.ts", "src/rooms/writer/server/plan-fact.ts", "src/rooms/workflow/ui/editor.tsx",
  "docs/atlas.md", "src/rooms/storage/database.ts", "src/rooms/native-agent/server/helper-probe.ts", "src/rooms/memory/memory-paths.ts", "bb-plugin.json"]}
head = d.git(str(d.ROOT), "rev-parse", "HEAD")
out = {"reads": reads}
import os
folder = pathlib.Path(tempfile.mkdtemp())
out["deploy"] = sorted(d.select_quick(folder)[1])
os.environ["LP_DRILL_LIVE"] = "1"
for label, age in (("fresh", 3600), ("stale", 30 * 3600)):
    folder = pathlib.Path(tempfile.mkdtemp())
    (folder / "r.json").write_text(json.dumps({"commit": head, "finishedAt": (time.time() - age) * 1000, "scenarios": [{"name": n, "result": "pass"} for n in d.QUICK]}))
    names, skipped = d.select_quick(folder)
    out[label] = {"names": names, "skipped": sorted(skipped)}
print(json.dumps(out))
`;
    const run = spawnSync("python3", ["-I", "-c", code, fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url))], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    expect(out.reads).toEqual({
      "src/rooms/phase/server/driver.ts": [], "src/rooms/writer/server/plan-fact.ts": ["parallel3"], "src/rooms/workflow/ui/editor.tsx": [], "docs/atlas.md": [],
      "src/rooms/storage/database.ts": ["memory_paths", "helper_providers", "parallel3"], "src/rooms/native-agent/server/helper-probe.ts": ["memory_paths", "helper_providers", "parallel3"],
      "src/rooms/memory/memory-paths.ts": ["memory_paths", "parallel3"], "bb-plugin.json": ["memory_paths", "helper_providers", "parallel3"],
    });
    // A deploy (no LP_DRILL_LIVE) runs no live scenario even with no receipt at all: they run nightly.
    expect(out.deploy).toEqual(["helper_providers", "memory_paths", "parallel3"]);
    // LP_DRILL_LIVE=1: nothing changed since HEAD passed an hour ago: only the scenarios without models run; a day later all of them do.
    expect(out.fresh).toEqual({ names: ["guard_hash", "deferrals", "checkers", "lead_shadow", "episodes"], skipped: ["helper_providers", "memory_paths", "parallel3"] });
    expect(out.stale).toEqual({ names: ["guard_hash", "deferrals", "checkers", "memory_paths", "helper_providers", "parallel3", "lead_shadow", "episodes"], skipped: [] });
  });

  it("[sma:ta_cleanup] parallel3: an accepted task whose worktree, lane branch, folder or registry row is left is red; a fully removed one is green", () => {
    const code = String.raw`
import importlib.util, json, os, subprocess, sys, tempfile
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
tmp = tempfile.mkdtemp(prefix="lp-drill-wt-")
base = os.path.join(tmp, "sandbox")
g = lambda cwd, *a: subprocess.run(["git", "-C", cwd, *a], check=True, capture_output=True, text=True).stdout
os.makedirs(base); g(base, "init", "-q", "-b", "main"); g(base, "config", "user.email", "t@t"); g(base, "config", "user.name", "t")
open(os.path.join(base, "a.txt"), "w").write("a"); g(base, "add", "."); g(base, "commit", "-qm", "init")
left = os.path.join(tmp, "wt", "sandbox", "lpattempt_left")
g(base, "worktree", "add", "-q", "-b", "lane/lpattempt_left", left, "HEAD")
gone = os.path.join(tmp, "wt", "sandbox", "lpattempt_gone")
task = lambda attempt, path: {"task": attempt, "state": "accepted", "attempt": attempt, "workspace": path}
print(json.dumps([
  d.worktree_leftovers(base, task("lpattempt_left", left), [{"path": left, "released_at": None}]),
  d.worktree_leftovers(base, task("lpattempt_gone", gone), [{"path": gone, "released_at": 1}]),
  d.worktree_leftovers(base, task("lpattempt_gone", gone), []),
  d.worktree_leftovers(base, {**task("lpattempt_left", left), "state": "failed"}, []),
]))
`;
    const run = spawnSync("python3", ["-I", "-c", code, fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url))], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    expect(run.status, run.stderr).toBe(0);
    const [left, gone, noRow, failed] = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as string[][];
    expect(left).toHaveLength(4);
    expect(left.join("\n")).toMatch(/git worktree list still has .*lpattempt_left/);
    expect(left.join("\n")).toContain("branch lane/lpattempt_left is still there");
    expect(left.join("\n")).toContain("is still on disk");
    expect(left.join("\n")).toContain("is not released");
    expect(gone).toEqual([]);
    expect(noRow).toEqual(["lpattempt_gone: no lane_pilot_worktree row for attempt lpattempt_gone"]);
    expect(failed).toEqual([]);
  });

  it("[sma:m_boot_wt_sweep] parallel3: a worktree-cleanup system schedule whose last run failed start_failed, or that is missing, is red", () => {
    const code = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
hourly = {"created_by": "system:worktree-cleanup-hourly", "name": "Уборка worktree: ежечасно", "state": "active"}
daily = {"created_by": "system:worktree-cleanup-daily", "name": "Уборка worktree: ежедневно", "state": "active"}
refused = {"status": "failed", "reason": "start_failed", "error": "could not start: not_runnable: \"lp.worktree-cleanup\" is not a workflow to start by hand."}
print(json.dumps([
  d.cleanup_schedule_problems([{**hourly, **refused}, {**daily, **refused}]),
  d.cleanup_schedule_problems([{**hourly, "status": "succeeded"}, {**daily, "status": None}]),
  d.cleanup_schedule_problems([{**hourly, "status": "succeeded"}]),
]))
`;
    const run = spawnSync("python3", ["-I", "-c", code, fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url))], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    expect(run.status, run.stderr).toBe(0);
    const [refused, fine, missing] = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as string[][];
    expect(refused).toHaveLength(2);
    expect(refused[0]).toContain("start_failed");
    expect(refused[0]).toContain("not a workflow to start by hand");
    expect(fine).toEqual([]);
    expect(missing).toEqual(["the system schedule system:worktree-cleanup-daily is not on the board"]);
  });

  it("series_preparation: the wrapped `plugin list` answer is unwrapped; an unreadable answer or a missing lane-pilot row is a named database problem", () => {
    const code = String.raw`
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
version = json.loads((d.ROOT / "package.json").read_text())["version"]
d.git = lambda *a, **k: ""
d.hubsql = lambda sql: []
d.scout = lambda: {}
d.bb = lambda *a, **k: (0, '{"gaps": []}', "")
for name in ("_browser_probe", "_accounts_probe", "_limits_probe", "_window_probe", "_person_probe"):
    setattr(d, name, lambda *a, **k: (True, "stubbed"))
receipt_dir = tempfile.TemporaryDirectory()
os.environ["LP_DRILL_RECEIPT_DIR"] = receipt_dir.name
def prep(rc, out):
    d.run = lambda args, **k: (rc, out, "")
    p = d.series_preparation()
    return {"database": next(c for c in p["checks"] if c["name"] == "database"), "problems": p["problems"]}
lp = {"id": "lane-pilot", "version": version}
print(json.dumps([
    prep(0, json.dumps({"plugins": [lp]})),
    prep(0, json.dumps([lp])),
    prep(1, ""),
    prep(0, "not json"),
    prep(0, json.dumps({"plugins": [{"id": "other", "version": "1"}]})),
    prep(0, json.dumps({"plugins": [{"id": "lane-pilot", "version": "0.0.0-old"}]})),
]))
receipt_dir.cleanup()
`;
    const run = spawnSync("python3", ["-I", "-c", code, fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url))], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    expect(run.status, run.stderr).toBe(0);
    const [wrapped, legacy, badRc, badJson, missing, old] = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Array<{ database: { ok: boolean }; problems: string[] }>;
    const dbProblems = (row: { problems: string[] }) => row.problems.filter((problem) => problem.startsWith("database:"));
    expect(wrapped.database.ok).toBe(true);
    expect(dbProblems(wrapped)).toEqual([]);
    expect(legacy.database.ok).toBe(true);
    expect(dbProblems(legacy)).toEqual([]);
    expect(badRc.database.ok).toBe(false);
    expect(dbProblems(badRc)).toEqual(["database: bb plugin list exited 1"]);
    expect(badJson.database.ok).toBe(false);
    expect(dbProblems(badJson)[0]).toMatch(/^database: /);
    expect(missing.database.ok).toBe(false);
    expect(dbProblems(missing)).toEqual(["database: `bb plugin list` has no lane-pilot row with a version"]);
    expect(old.database.ok).toBe(false);
    expect(dbProblems(old)).toEqual([expect.stringContaining("the hub runs lane-pilot 0.0.0-old")]);
  });
});

describe("region scenes sma_rNN (docs/sma-evidence.md)", () => {
  const door = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));
  const scenes = fileURLToPath(new URL("../scripts/lp_drill/scenes/", import.meta.url));
  const quiet = { ...ownEnv, BB_CLI: "/nonexistent/bb" };

  it("a file scenes/sma_rNN.py is found by its name: --scenario and --suite sma run it, --quick, the default list and ALL stay as they were", () => {
    const file = `${scenes}sma_r98.py`;
    writeFileSync(file, 'from lp_drill.prove import Proofs\nNODES = ["n1"]\ndef scenario_sma_r98(tmp):\n    p = Proofs()\n    p.prove("n1", True, "seen 1")\n    return p.verdict("sma_r98")\n');
    try {
      const one = spawnSync("bash", [script, "--scenario", "sma_r98", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: quiet });
      expect(one.status).toBe(0);
      expect(one.stdout).toContain("scenarios: sma_r98");
      expect(one.stdout).toContain('"proves": ["n1"]');
      const suite = spawnSync("bash", [script, "--suite", "sma", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: quiet });
      expect(suite.status).toBe(0);
      const present = readdirSync(scenes).filter((name) => /^sma_(r\d+|core|tails)\.py$/.test(name)).map((name) => name.replace(".py", "")).sort();
      expect(suite.stdout).toContain(`scenarios: ${present.join(", ")}`);
      const quick = spawnSync("bash", [script, "--quick", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...quiet, LP_DRILL_SELECT: "0" } });
      expect(quick.stdout).not.toContain("sma_r");
      expect(spawnSync("bash", [script, "--dry-run"], { encoding: "utf8", timeout: 30_000, env: quiet }).stdout).not.toContain("sma_r");
      const code = `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)\nprint(json.dumps({"sma": sorted(d.SMA_SCENES), "all": [n for n in d.ALL + d.EXTRA + d.BY_NAME if n.startswith("sma")], "scout": d.scout()["unlisted"]}))`;
      const seen = JSON.parse(spawnSync("python3", ["-I", "-c", code, door], { encoding: "utf8", env: quiet }).stdout.trim().split("\n").at(-1)!);
      expect(seen).toEqual({ sma: present, all: [], scout: [] });
    } finally { rmSync(file, { force: true }); }
  });

  it("prove(): a false ok fails the scene with a problem line naming the node; a scene that proved nothing fails; the entry lists what was proved", () => {
    const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
good = d.Proofs(); good.prove("n1036", True, "leak scan returned []")
bad = d.Proofs(); bad.prove("n1036", True, "fine"); bad.prove("n1037", False, "ids refused in []")
none = d.Proofs()
errors = []
for call in (lambda: good.prove("1036", True, "x"), lambda: good.prove("n1036", True, "again")):
    try: call()
    except ValueError as cause: errors.append(str(cause))
print(json.dumps({"good": good.verdict("s"), "bad": bad.verdict("s"), "none": none.verdict("s"), "errors": errors, "judged": d.judge_scenario(good.verdict("s"))["verdict"]}))`;
    const run = spawnSync("python3", ["-I", "-c", code, door], { encoding: "utf8", timeout: 30_000, env: quiet });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    expect(out.good).toMatchObject({ result: "pass", problems: [], proved: [{ node: "n1036", ok: true, detail: "leak scan returned []" }] });
    expect(out.bad.result).toBe("fail");
    expect(out.bad.problems).toEqual(["n1037: not proved, ids refused in []"]);
    expect(out.bad.proved).toHaveLength(2);
    expect(out.none).toMatchObject({ result: "fail", problems: [expect.stringContaining("proved no node")] });
    expect(out.errors).toEqual([expect.stringContaining("not a map node id"), expect.stringContaining("proved twice")]);
    expect(out.judged).toBe("pass");
  });

  it("the receipt is delivered to the hub over ssh; a failure is a problem line, and `off` is the only way not to try", () => {
    const code = `import importlib.util, json, os, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
f = Path(tempfile.mkdtemp()) / "2026-11-14-sma1.json"; f.write_text('{"a": 1}')
calls = []
def ok(args, stdin=None, timeout=0): calls.append([args, stdin]); return 0, "", ""
def fail(args, stdin=None, timeout=0): return 255, "", "ssh: connect refused"
res = {"ok": d.deliver_receipt(f, ok), "fail": d.deliver_receipt(f, fail), "call": calls[0]}
os.environ["LP_DRILL_HUB_RECEIPTS"] = "off"; res["off"] = d.deliver_receipt(f, fail)
print(json.dumps(res))`;
    const env = Object.fromEntries(Object.entries({ ...quiet }).filter(([name]) => name !== "LP_DRILL_HUB_RECEIPTS"));
    const run = spawnSync("python3", ["-I", "-c", code, door], { encoding: "utf8", timeout: 30_000, env });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    expect(out.ok).toBeNull();
    expect(out.fail).toMatch(/2026-11-14-sma1\.json was not delivered to the hub.*connect refused/);
    expect(out.off).toBeNull();
    expect(out.call[0].at(-1)).toContain("bb-plugin-lane-pilot/.agents/runs/drills");
    expect(out.call[0].at(-1)).toContain("2026-11-14-sma1.json");
    expect(out.call[1]).toBe('{"a": 1}');
  });

  it("LP_DRILL_SMA_PRIMARY_ONLY holds the worktree batches: their prove_* never run, held nodes land in notProved only, checked counts what ran; unset runs all", () => {
    const code = `import importlib, json, os, sys, tempfile, types
from pathlib import Path
scripts = Path(sys.argv[1]).resolve().parent
sys.path.insert(0, str(scripts))
pkg = types.ModuleType("lp_drill.scenes")
pkg.__path__ = [str(scripts / "lp_drill" / "scenes")]
sys.modules["lp_drill.scenes"] = pkg
calls = []
def stub(prefix, tag, node):
    name = "lp_drill.scenes." + prefix + "_" + tag
    m = types.ModuleType(name)
    setattr(m, "NODES_" + tag.upper(), [node])
    def prove(proofs, tmp, _t=prefix + ":" + tag, _n=node):
        calls.append(_t)
        proofs.prove(_n, True, "stub " + _t)
    setattr(m, "prove_" + tag, prove)
    sys.modules[name] = m
for tag, node in (("a","n901"),("b","n902"),("c","n903"),("d","n904"),("e","n905"),("f","n906"),("g","n907"),("h","n908")):
    stub("sma_r01", tag, node)
for tag, node in (("b","n911"),("c","n912"),("d","n913"),("g","n914"),("h","n915"),("e","n916"),("f","n917")):
    stub("sma_r16", tag, node)
import subprocess
class Done:
    stdout = "{}"
    stderr = ""
    returncode = 0
subprocess.run = lambda *a, **k: Done()
r01m = importlib.import_module("lp_drill.scenes.sma_r01")
r16m = importlib.import_module("lp_drill.scenes.sma_r16")
def brief(v, c):
    return {"result": v["result"], "checked": v.get("checked"), "proved": sorted(p["node"] for p in v["proved"]),
            "notProved": v.get("notProved"), "hasNotProved": "notProved" in v, "hasPrimaryOnly": "primaryOnly" in v,
            "primaryOnly": v.get("primaryOnly"), "calls": c}
out = {}
with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    for mode in ("on", "off"):
        if mode == "on":
            os.environ["LP_DRILL_SMA_PRIMARY_ONLY"] = "1"
        else:
            os.environ.pop("LP_DRILL_SMA_PRIMARY_ONLY", None)
        calls.clear(); v = r01m.scenario_sma_r01(tmp); c1 = list(calls)
        calls.clear(); w = r16m.scenario_sma_r16(tmp); c2 = list(calls)
        out[mode] = {"r01": brief(v, c1), "r16": brief(w, c2)}
print(json.dumps(out))`;
    const run = spawnSync("python3", ["-I", "-c", code, door], { encoding: "utf8", timeout: 30_000, env: quiet });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    expect(out.on.r01.calls).toEqual(["sma_r01:b", "sma_r01:f", "sma_r01:g", "sma_r01:h"]);
    expect(out.on.r01.checked).toBe(4);
    expect(out.on.r01.proved).toEqual(["n902", "n906", "n907", "n908"]);
    expect(Object.keys(out.on.r01.notProved).sort()).toEqual(["n901", "n903", "n904", "n905"]);
    for (const id of ["n901", "n903", "n904", "n905"]) {
      expect(out.on.r01.notProved[id]).toContain("PRIMARY-only hold");
      expect(out.on.r01.proved).not.toContain(id);
    }
    expect(out.on.r01.primaryOnly).toBe(true);
    expect(out.on.r16.calls).toEqual(["sma_r16:b", "sma_r16:d", "sma_r16:g", "sma_r16:e", "sma_r16:f"]);
    expect(out.on.r16.checked).toBe(35);
    for (const id of ["n912", "n915"]) {
      expect(out.on.r16.notProved[id]).toContain("PRIMARY-only hold");
      expect(out.on.r16.proved).not.toContain(id);
    }
    for (const id of ["n911", "n913", "n914", "n916", "n917"]) expect(out.on.r16.proved).toContain(id);
    expect(out.on.r16.primaryOnly).toBe(true);
    expect(out.off.r01.calls).toEqual(["sma_r01:a", "sma_r01:b", "sma_r01:c", "sma_r01:d", "sma_r01:e", "sma_r01:f", "sma_r01:g", "sma_r01:h"]);
    expect(out.off.r01.checked).toBe(8);
    expect(out.off.r01.hasNotProved).toBe(false);
    expect(out.off.r01.hasPrimaryOnly).toBe(false);
    expect(out.off.r16.calls).toEqual(["sma_r16:b", "sma_r16:c", "sma_r16:d", "sma_r16:g", "sma_r16:h", "sma_r16:e", "sma_r16:f"]);
    expect(out.off.r16.checked).toBe(37);
    expect(out.off.r16.hasNotProved).toBe(false);
    expect(out.off.r16.hasPrimaryOnly).toBe(false);
  });

  it("LP_DRILL_SMA_PRIMARY_ONLY holds exactly the 10 worktree nodes of r04 r08 r20 r23 r24 r25: their probe units are guarded, never proved, notProved only; unset runs all", () => {
    // Static half: each probe skips exactly its worktree unit before calling it (running the probes would run git, so they are not run here).
    const probe = (name: string) => readFileSync(`${scenes}${name}`, "utf8");
    for (const [file, unit, guard] of [
      ["sma_r24_probe.ts", 'new Set(["n1653"])', "if (PRIMARY_ONLY_HELD.has(id)) return;"],
      ["sma_r25_probe.ts", 'new Set(["rollback"])', "if (PRIMARY_ONLY_HELD.has(name)) return;"],
      ["sma_r04_probe.test.ts", 'new Set(["copies"])', "if (!PRIMARY_ONLY_HELD.has(name)) try {"],
      ["sma_r08_b_probe.ts", 'new Set(["worktree"])', "if (PRIMARY_ONLY_HELD.has(name)) return;"],
    ] as const) {
      const text = probe(file);
      expect(text, file).toContain(`process.env.LP_DRILL_SMA_PRIMARY_ONLY === "1" ? ${unit}`);
      expect(text.split(guard).length - 1, file).toBe(1);
    }
    for (const [file, next] of [["sma_r20_probe.ts", "// ---- STATE.md"], ["sma_r23_probe.ts", "// ---- n1629"]] as const) {
      const text = probe(file), open = 'if (process.env.LP_DRILL_SMA_PRIMARY_ONLY !== "1") {';
      expect(text.split(open).length - 1, file).toBe(1);
      const from = text.indexOf(open), to = text.indexOf(next, from);
      const adds = [...text.matchAll(/"worktree", "add"/g)].map((m) => m.index!);
      expect(adds.length, file).toBeGreaterThan(0);
      for (const at of adds) expect(at > from && at < to, `${file}: every worktree add sits inside the guarded block`).toBe(true);
    }
    // Functional half: the scenes with a stubbed probe call — held nodes are never proved, land in notProved, checked counts only what ran.
    const code = `import importlib, json, os, subprocess, sys, tempfile, types
from pathlib import Path
scripts = Path(sys.argv[1]).resolve().parent
sys.path.insert(0, str(scripts))
pkg = types.ModuleType("lp_drill.scenes")
pkg.__path__ = [str(scripts / "lp_drill" / "scenes")]
sys.modules["lp_drill.scenes"] = pkg
envs = []
class Done:
    returncode = 0
    stderr = ""
    def __init__(self, out):
        self.stdout = out
def fake(args, **kw):
    env = kw.get("env") or os.environ
    envs.append(env.get("LP_DRILL_SMA_PRIMARY_ONLY"))
    if "SMA_R04_OUT" in env:
        Path(env["SMA_R04_OUT"]).write_text("{}")
    return Done(json.dumps({"nodes": {}, "home": "/tmp/h"}) if any("sma_r24_probe" in str(a) for a in args) else "{}")
subprocess.run = fake
mods = {n: importlib.import_module("lp_drill.scenes.sma_" + n) for n in ("r04", "r08", "r08_b", "r20", "r23", "r24", "r25")}
out = {"nodes": {n: len(mods[n].NODES) for n in ("r04", "r08", "r20", "r23", "r24", "r25")}}
with tempfile.TemporaryDirectory() as td:
    for mode in ("on", "off"):
        if mode == "on":
            os.environ["LP_DRILL_SMA_PRIMARY_ONLY"] = "1"
        else:
            os.environ.pop("LP_DRILL_SMA_PRIMARY_ONLY", None)
        envs.clear()
        row = {"held": sorted([*mods["r04"].PRIMARY_ONLY_HELD, *mods["r08_b"].held_b(), *mods["r20"].PRIMARY_ONLY_HELD,
                               *mods["r23"].PRIMARY_ONLY_HELD, *mods["r24"].PRIMARY_ONLY_HELD, *mods["r25"].PRIMARY_ONLY_HELD]),
               "heldB": sorted(mods["r08_b"].held_b())}
        for n in ("r04", "r24", "r25"):
            sub = Path(td) / (mode + n)
            sub.mkdir()
            v = getattr(mods[n], "scenario_sma_" + n)(sub)
            row[n] = {"checked": v.get("checked"), "proved": sorted(p["node"] for p in v["proved"]), "notProved": sorted(v.get("notProved") or {}),
                      "primaryOnly": v.get("primaryOnly"), "reasons": sorted(set((v.get("notProved") or {}).values())),
                      "hasPrimaryOnly": "primaryOnly" in v, "hasNotProved": "notProved" in v}
        row["envs"] = list(envs)
        out[mode] = row
print(json.dumps(out))`;
    const run = spawnSync("python3", ["-I", "-c", code, door], { encoding: "utf8", timeout: 30_000, env: quiet });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    expect(out.nodes).toEqual({ r04: 25, r08: 59, r20: 32, r23: 22, r24: 23, r25: 24 });
    const held = ["n1532", "n1542", "n1544", "n1627", "n1653", "n1681", "n1694", "n1709", "n421", "n729"];
    expect(out.on.held).toEqual(held);
    expect(out.on.heldB).toEqual(["n729"]);
    expect(out.off.heldB).toEqual([]);
    expect(out.on.envs).toEqual(["1", "1", "1"]);
    for (const [scene, ids, checked] of [["r04", ["n421"], 24], ["r24", ["n1653"], 22], ["r25", ["n1681", "n1694", "n1709"], 21]] as const) {
      expect(out.on[scene].notProved, scene).toEqual([...ids]);
      expect(out.on[scene].checked, scene).toBe(checked);
      expect(out.on[scene].primaryOnly, scene).toBe(true);
      for (const reason of out.on[scene].reasons) expect(reason, scene).toContain("PRIMARY-only hold");
      for (const id of ids) {
        expect(out.on[scene].proved, scene).not.toContain(id);
        expect(out.off[scene].proved, scene).toContain(id);
      }
      expect(out.off[scene].checked, scene).toBe(checked + ids.length);
      expect(out.off[scene].notProved, scene).toEqual([]);
      expect(out.off[scene].hasPrimaryOnly, scene).toBe(false);
      expect(out.off[scene].hasNotProved, scene).toBe(false);
    }
  });
});
