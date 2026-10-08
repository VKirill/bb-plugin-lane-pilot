import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";

const script = fileURLToPath(new URL("../scripts/lp-drill.sh", import.meta.url));

describe("scripts/lp-drill.sh (E3)", () => {
  it("--dry-run prints three valid, non-overlapping task-v2 documents and touches nothing", () => {
    const run = spawnSync("bash", [script, "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BB_CLI: "/nonexistent/bb" } });
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
    const run = spawnSync("bash", [script, "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BB_CLI: "/nonexistent/bb" } });
    const lines = run.stdout.split("\n").filter((line) => line.startsWith("scenario "));
    const byScenario = new Map<string, ReturnType<typeof taskV2Schema.parse>[]>();
    for (const line of lines) {
      const [, name, json] = /^scenario (\w+): (\{.*\})$/.exec(line)!;
      byScenario.set(name!, [...(byScenario.get(name!) ?? []), taskV2Schema.parse(JSON.parse(json!))]);
    }
    expect([...byScenario.keys()]).toEqual(["conflict", "main_moved", "provider", "provider_limit", "reload", "nogit"]);
    expect(byScenario.get("conflict")).toHaveLength(2);
    const [x, y] = byScenario.get("conflict")!;
    expect(x!.owns_paths).toEqual(y!.owns_paths);
    expect(byScenario.get("nogit")![0]!.project_cwd).toBe("/Users/vechkasov/lp-sandbox-layouts/n-nogit");
    for (const tasks of byScenario.values()) for (const task of tasks) expect(task.expected_outputs.every((path) => task.owns_paths.includes(path))).toBe(true);
  });

  it("--quick is the guard hash check, the helper per provider and the three-task scenario, and an unknown scenario is refused", () => {
    const quick = spawnSync("bash", [script, "--quick", "--dry-run"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BB_CLI: "/nonexistent/bb" } });
    expect(quick.status).toBe(0);
    expect(quick.stdout).toContain("scenarios: guard_hash, helper_providers, parallel3");
    expect(quick.stdout).not.toContain("scenario conflict");
    const unknown = spawnSync("bash", [script, "--scenario", "nope", "--dry-run"], { encoding: "utf8", timeout: 30_000 });
    expect(unknown.status).toBe(2);
  });
});
