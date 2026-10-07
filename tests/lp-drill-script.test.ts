import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/contracts";

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
});
