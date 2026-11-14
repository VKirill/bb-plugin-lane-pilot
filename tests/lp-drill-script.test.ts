import { spawnSync } from "node:child_process";
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
});
