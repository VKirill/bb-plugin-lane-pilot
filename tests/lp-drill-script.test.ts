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
    const quick = spawnSync("bash", [script, "--quick", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...ownEnv, BB_CLI: "/nonexistent/bb" } });
    expect(quick.status).toBe(0);
    expect(quick.stdout).toContain("scenarios: guard_hash, deferrals, checkers, memory_paths, helper_providers, parallel3");
    expect(quick.stdout).not.toContain("scenario conflict");
    const unknown = spawnSync("bash", [script, "--scenario", "nope", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: ownEnv });
    expect(unknown.status).toBe(2);
  });

  it("--quick leaves out a live scenario whose code did not change since it passed within a day, and runs it otherwise", () => {
    const code = String.raw`
import importlib.util, json, sys, tempfile, time, pathlib
spec = importlib.util.spec_from_file_location("drill", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
reads = {p: [n for n in d.LIVE if d.live_reads(n, p)] for p in ["src/rooms/phase/server/driver.ts", "src/rooms/writer/server/plan-fact.ts", "src/rooms/workflow/ui/editor.tsx",
  "docs/atlas.md", "src/rooms/storage/database.ts", "src/rooms/native-agent/server/helper-probe.ts", "src/rooms/memory/memory-paths.ts", "bb-plugin.json"]}
head = d.git(str(d.ROOT), "rev-parse", "HEAD")
out = {"reads": reads}
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
    // Nothing changed since HEAD passed an hour ago: only the scenarios without models run; a day later all of them do.
    expect(out.fresh).toEqual({ names: ["guard_hash", "deferrals", "checkers"], skipped: ["helper_providers", "memory_paths", "parallel3"] });
    expect(out.stale).toEqual({ names: ["guard_hash", "deferrals", "checkers", "memory_paths", "helper_providers", "parallel3"], skipped: [] });
  });
});
