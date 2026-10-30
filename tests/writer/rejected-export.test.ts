import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerSecrets } from "@lane-pilot/kit";
import { openDatabase } from "../../src/rooms/storage/database";
import {
  exportRejectedTrajectories,
  getRejectedTrajectoriesSummary,
  recordRejectedTrajectory,
  rejectedTrajectoriesMorningLine,
  runWriterCli,
} from "../../src/rooms/writer/rejected-export";

describe("rejected trajectories DB export and CLI (Item 4)", () => {
  it("recordRejectedTrajectory saves to database without touching filesystem and redacts secrets", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);

    const SECRET = "sk-super-secret-key-99999";
    registerSecrets([SECRET]);

    const res = recordRejectedTrajectory(db, {
      attemptId: "att_fail_1",
      taskId: "task_test_1",
      projectId: "proj_1",
      runId: "run_1",
      state: "validation_failed",
      reason: `test failed with secret: ${SECRET}`,
      task: {
        id: "task_test_1",
        title: `Secret in title: ${SECRET}`,
        acceptance: [`check ${SECRET}`],
        owns_paths: ["src/auth.ts"],
      },
      events: [
        { type: "toolCall", input: { auth: SECRET } },
      ],
      now: 1730000000000,
    });

    expect(res).not.toBeNull();
    expect(res!.id).toBeDefined();
    expect(res!.bytes).toBeGreaterThan(0);

    // Verify row in database
    const saved = db.prepare("SELECT * FROM lane_pilot_rejected_trajectory WHERE attempt_id = ?").get("att_fail_1") as any;
    expect(saved).toBeDefined();
    expect(saved.task_id).toBe("task_test_1");
    expect(saved.trajectory_json).not.toContain(SECRET);
    expect(saved.trajectory_json).toContain("***");

    const parsed = JSON.parse(saved.trajectory_json);
    expect(parsed.attemptId).toBe("att_fail_1");
    expect(parsed.state).toBe("validation_failed");
    expect(parsed.reason).not.toContain(SECRET);

    const summary = getRejectedTrajectoriesSummary(db, 1730000000000 - 1000, 1730000000000 + 1000);
    expect(summary).not.toBeNull();
    expect(summary!.count).toBe(1);

    const morningLine = rejectedTrajectoriesMorningLine(db, 1730000000000);
    expect(morningLine).toContain("Экспорт отклонённых траекторий: сохранено 1 траекторий");
    expect(morningLine).toContain("без секретов");
  });

  it("exportRejectedTrajectories exports to file on caller machine", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const dir = await mkdtemp(join(tmpdir(), "lp-traj-cli-"));
    const outPath = join(dir, "out.jsonl");

    recordRejectedTrajectory(db, {
      attemptId: "att_1",
      taskId: "task_1",
      projectId: "proj_1",
      state: "failed",
      reason: "syntax error",
    });

    try {
      const exported = await exportRejectedTrajectories(db, { outputPath: outPath });
      expect(exported.count).toBe(1);
      const content = await readFile(outPath, "utf8");
      expect(content).toContain("att_1");
      expect(content).toContain("syntax error");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("runWriterCli handles trajectories export subcommand", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);

    recordRejectedTrajectory(db, {
      attemptId: "att_cli",
      taskId: "task_cli",
      projectId: "proj_cli",
      state: "blocked",
      reason: "verification failed",
    });

    const resStdout = await runWriterCli(db, ["trajectories", "export"]);
    expect(resStdout.exitCode).toBe(0);
    expect(resStdout.stdout).toContain("att_cli");

    const dir = await mkdtemp(join(tmpdir(), "lp-traj-cli2-"));
    const outPath = join(dir, "export.jsonl");

    try {
      const resFile = await runWriterCli(db, ["trajectories", "export", "--out", outPath]);
      expect(resFile.exitCode).toBe(0);
      expect(resFile.stdout).toContain(`Exported 1 rejected trajectories`);

      const fileContent = await readFile(outPath, "utf8");
      expect(fileContent).toContain("att_cli");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejectedTrajectoriesMorningLine returns null when no trajectories in window", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(rejectedTrajectoriesMorningLine(db)).toBeNull();
  });
});
