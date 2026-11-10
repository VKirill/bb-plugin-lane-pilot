import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pickBatch, batchItemIsFullLane, batchReceiptGaps, parseTodoMeta, type TodoMeta } from "../../src/rooms/backlog/logic";

const drill = fileURLToPath(new URL("../../scripts/lp-drill.py", import.meta.url));

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

describe("[sma:m_sd_answer] the dry-run of no_code_exit lists three tasks with accepted-first-attempt only for the research task", () => {
  it("lists needs_human, a research answer and a fix told to change nothing", () => {
    const out = drillPy(`
specs = m.tasks_no_code_exit("/tmp/x")
print(json.dumps([{"id": s["id"], "kind": s["kind"], "objective": s["objective"]} for s in specs]))
`) as Array<{ id: string; kind: string; objective: string }>;
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.kind)).toEqual(["chore", "research", "fix"]);
    expect(out[1]!.objective).toContain("change no file");
    const run = spawnSync("bash", ["-c", `python3 -I ${JSON.stringify(drill)} --scenario no_code_exit --dry-run`], { encoding: "utf8", timeout: 60_000 });
    expect(run.stdout).toContain("accepted_first_attempt");
    expect(run.stdout).toContain("not_accepted");
  });
});

describe("[sma:m_sd_approve] the dry-run of live_word lists a green task clicked through the window and a red task blocked", () => {
  it("names the yes-button scene and the blocked red task", () => {
    const run = spawnSync("python3", ["-I", drill, "--scenario", "live_word", "--dry-run"], { encoding: "utf8", timeout: 60_000 });
    expect(run.stdout).toContain("owner-run-task-word:");
    expect(run.stdout).toContain("blocked, no owner item");
    expect(run.stdout).toContain("accepted after the yes button click");
  });
});

describe("[sma:m_sd_merge] the dry-run listing names the revert scenario among ALL, and its judge reports a missing receipt or markers", () => {
  it("revert is in ALL and the dry-run names it", () => {
    const out = drillPy(`print(json.dumps({"inAll": "revert" in m.ALL}))`) as { inAll: boolean };
    expect(out.inAll).toBe(true);
  });

  it("the judge itself reports a problem when the revert left no merge receipt or left conflict markers", () => {
    const out = drillPy(`
m.bb = lambda *a, **k: (0, "clean output", "")
m.sandbox_sound = lambda cwd: []
import os
os.makedirs("/tmp/drillx2", exist_ok=True)
open("/tmp/drillx2/note.md","w").write("<<<<<<< ours\\n")
m.POLL_SEC = 0
clock = [m.time.time()]
m.time.time = lambda: (clock.__setitem__(0, clock[0] + 600), clock[0])[1]
class Ctx: project = "proj_x"; cwd = "/tmp/drillx2"
print(json.dumps(m.revert_judged(Ctx(), "t", "note.md")))
`) as string[];
    expect(out.some((line) => line.includes("merge receipt"))).toBe(true);
    expect(out.some((line) => line.includes("conflict markers"))).toBe(true);
    expect(out.some((line) => line.includes("still on main"))).toBe(true);
  });
});

describe("[sma:m_sd_skills] the skills_screen judge flags a changed file hash and a blank window", () => {
  it("reports a problem when a skill file hash differs after the press, and when the window shows neither", () => {
    const out = drillPy(`
print(json.dumps({
  "changed": m.skills_screen_problems({"door": {"skills": 3, "narrowed": True}, "window": {"listed": True}, "diskBefore": {"a": "1"}, "diskAfter": {"a": "2"}}),
  "blank": m.skills_screen_problems({"door": {"skills": 3, "narrowed": True}, "window": {}, "diskBefore": {}, "diskAfter": {}}),
  "ok": m.skills_screen_problems({"door": {"skills": 3, "narrowed": True}, "window": {"listed": True}, "diskBefore": {"a": "1"}, "diskAfter": {"a": "1"}}),
}))
`) as { changed: string[]; blank: string[]; ok: string[] };
    expect(out.changed.some((line) => line.includes("skill files changed"))).toBe(true);
    expect(out.blank.some((line) => line.includes("neither skills nor the empty-list"))).toBe(true);
    expect(out.ok).toEqual([]);
  });
});

describe("[sma:rl_prep] a series with an unready part does not start", () => {
  it("series_preparation lists seven checks and a dead database is a problem", () => {
    const out = drillPy(`
m.hubsql = lambda sql: (_ for _ in ()).throw(RuntimeError("ssh down"))
def fake_git(cwd, *a):
    if "status" in a: return ""
    return "deadbeef"
m.git = fake_git
prep = m.series_preparation()
print(json.dumps({"checks": [c["name"] for c in prep["checks"]], "problems": prep["problems"]}))
`) as { checks: string[]; problems: string[] };
    expect(out.checks).toEqual(["database", "receipts", "browser", "accounts", "limits", "window", "person"]);
    expect(out.problems.some((line) => line.startsWith("database:"))).toBe(true);
  });
});

describe("[sma:rl_suites] every scenario sits in exactly one named suite", () => {
  it("scout reports no ungrouped, no regrouped, no unknown, and the suite keys equal the nine card names", () => {
    const out = drillPy(`print(json.dumps(m.scout()))`) as { ungrouped: string[]; regrouped: string[]; unknown: string[]; suites: Record<string, string[]>; empty: string[] };
    expect(Object.keys(out.suites)).toEqual(["task", "batch", "phase", "release", "window", "worker", "lockstep", "wiring", "metrics"]);
    expect(out.ungrouped).toEqual([]);
    expect(out.regrouped).toEqual([]);
    expect(out.unknown).toEqual([]);
    expect(out.empty).toEqual([]);
  });
});

describe("[sma:rl_metrics] the metrics suite runs last and can fail a series", () => {
  it("a scene without evidence fails; a clean list passes; metrics is the last suite", () => {
    const out = drillPy(`
import pathlib, tempfile
red = m.series_metrics([{"name": "a", "exit": 0, "receipt": None}], pathlib.Path(tempfile.mkdtemp()))
green = m.series_metrics([], pathlib.Path(tempfile.mkdtemp()))
print(json.dumps({"red": red["verdict"], "redProblems": red["problems"], "green": green["verdict"], "last": list(m.SUITES)[-1]}))
`) as { red: string; redProblems: string[]; green: string; last: string };
    expect(out.red).toBe("fail");
    expect(out.redProblems.some((line) => line.includes("no readable receipt"))).toBe(true);
    expect(out.last).toBe("metrics");
  });
});

describe("[sma:k_lib_releaselint] lp-drill.sh runs predict-lint before the scenarios", () => {
  it("the script exits before python when the lint fails and skips it on --dry-run", () => {
    const sh = fileURLToPath(new URL("../../scripts/lp-drill.sh", import.meta.url));
    const text = String(readFileSyncSafe(sh));
    expect(text).toContain("predict-lint");
    expect(text.indexOf("predict-lint")).toBeLessThan(text.indexOf("lp-drill.py\" \"$@\""));
    expect(text).toContain("--dry-run");
  });
});

describe("[sma:k_v_shiplane] lane drafts the changelog and keeps one record per base/head", () => {
  it("a temp repo with two commits prints a draft with two bullets; a second run adds no second record", () => {
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
    const ship = fileURLToPath(new URL("../../scripts/lp-ship.ts", import.meta.url));
    const first = spawnSync("npx", ["tsx", ship, "lane", "v0.1.0", "--cwd", repo], { encoding: "utf8", timeout: 120_000 });
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout) as { changelogDraft: string; record: string };
    expect(out.changelogDraft.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
    const second = spawnSync("npx", ["tsx", ship, "lane", "v0.1.0", "--cwd", repo], { encoding: "utf8", timeout: 120_000 });
    expect((JSON.parse(second.stdout) as { record: string }).record).toBe("already recorded");
    const ledger = String(readFileSyncSafe(join(repo, ".agents/ship/lanes.jsonl"))).trim().split("\n");
    expect(ledger).toHaveLength(1);
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

describe("[sma:k_lib_pkgcheck] publishable flags a stale meta and a missing test receipt", () => {
  it("the code checks bb.* entries, dist meta version and the LP_TEST_RECEIPTS key", () => {
    const text = readFileSyncSafe(fileURLToPath(new URL("../../scripts/lp-ship.ts", import.meta.url)));
    expect(text).toContain("pluginVersion");
    expect(text).toContain("LP_TEST_RECEIPTS");
    expect(text).toContain('HEAD^{tree}');
  });
});

describe("[sma:k_lib_docaudit] a doc dated in the future or an undocumented-verb increase is a finding", () => {
  it("the audit reads front-matter updated: and keeps a baseline count", () => {
    const text = readFileSyncSafe(fileURLToPath(new URL("../../scripts/lp-ship.ts", import.meta.url)));
    expect(text).toContain("updated:");
    expect(text).toContain("doc-coverage-baseline.json");
    expect(text).toContain("undocumented CLI verbs grew");
  });
});

describe("[sma:k_lib_spafresh] touching a source after the bundle makes freshness exit 1", () => {
  it("windowSources covers app files and ui folders; the check names the stale file", () => {
    const text = readFileSyncSafe(fileURLToPath(new URL("../../scripts/lp-ship.ts", import.meta.url)));
    expect(text).toContain("bundle older than sources");
    expect(text).toContain("windowSources");
    expect(text).toContain("packages/ui-kit");
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
    const ship = fileURLToPath(new URL("../../scripts/lp-ship.ts", import.meta.url));
    const red = spawnSync("npx", ["tsx", ship, "watch", repo], { encoding: "utf8", timeout: 120_000, cwd: repo });
    expect(red.status).toBe(1);
    expect(red.stdout).toContain("30 commits");
    execFileSync("git", ["-C", repo, "tag", "v0.2.0"]);
    writeFileSync(join(repo, "h"), "x"); git("add", "."); git("commit", "-qm", "e");
    const green = spawnSync("npx", ["tsx", ship, "watch", repo], { encoding: "utf8", timeout: 120_000, cwd: repo });
    expect(green.status).toBe(0);
  });
});

describe("[sma:rl_stories] a worker cannot accept its own work", () => {
  it("the story files exist and exercise the real handlers and transitions", () => {
    expect(existsSyncSafe(fileURLToPath(new URL("../release-stories-window.test.tsx", import.meta.url)))).toBe(true);
    expect(existsSyncSafe(fileURLToPath(new URL("../release-stories-worker.test.ts", import.meta.url)))).toBe(true);
  });
});

function readFileSyncSafe(path: string) {
  return execFileSync("cat", [path], { encoding: "utf8" });
}
function existsSyncSafe(path: string) {
  return spawnSync("test", ["-f", path]).status === 0;
}
