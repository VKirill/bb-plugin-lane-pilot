import { describe, it, expect } from "vitest";
import { bisectCulprit, type MergedTaskInfo } from "../../src/server/integration-gate";
import { spawnAsync } from "../../src/spawn-async";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("git bisect fallback on real git repository", () => {
  it("identifies the bad commit using git bisect run", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gate-bisect-test-"));

    // Initialize git repo
    await spawnAsync("git", ["init", "-b", "main"], { cwd: tempDir });
    await spawnAsync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
    await spawnAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });

    // Commit 1: good base
    await writeFile(join(tempDir, "status.txt"), "good");
    await spawnAsync("git", ["add", "."], { cwd: tempDir });
    await spawnAsync("git", ["commit", "-m", "initial base (good)"], { cwd: tempDir });
    const goodSha = (await spawnAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })).stdout.trim();

    // Commit 2: Task 1 (good)
    await writeFile(join(tempDir, "task1.txt"), "task 1 ok");
    await spawnAsync("git", ["add", "."], { cwd: tempDir });
    await spawnAsync("git", ["commit", "-m", "task 1"], { cwd: tempDir });
    const task1Sha = (await spawnAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })).stdout.trim();

    // Commit 3: Task 2 (culprit: changes status.txt to bad)
    await writeFile(join(tempDir, "status.txt"), "bad");
    await spawnAsync("git", ["add", "."], { cwd: tempDir });
    await spawnAsync("git", ["commit", "-m", "task 2 (bad)"], { cwd: tempDir });
    const task2Sha = (await spawnAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })).stdout.trim();

    // Commit 4: Task 3 (innocent)
    await writeFile(join(tempDir, "task3.txt"), "task 3 ok");
    await spawnAsync("git", ["add", "."], { cwd: tempDir });
    await spawnAsync("git", ["commit", "-m", "task 3"], { cwd: tempDir });
    const task3Sha = (await spawnAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir })).stdout.trim();

    const mergedTasks: MergedTaskInfo[] = [
      {
        taskId: "task-1",
        commitSha: task1Sha,
        threadId: "thr-1",
        attemptId: "att-1",
        produced: ["task1.txt"],
      },
      {
        taskId: "task-2",
        commitSha: task2Sha,
        threadId: "thr-2",
        attemptId: "att-2",
        produced: ["status.txt"],
      },
      {
        taskId: "task-3",
        commitSha: task3Sha,
        threadId: "thr-3",
        attemptId: "att-3",
        produced: ["task3.txt"],
      },
    ];

    // Gate command: fails if status.txt contains "bad"
    // test $(cat status.txt) = "good"
    const gateCommand = 'test "$(cat status.txt)" = "good"';

    const culprit = await bisectCulprit(gateCommand, goodSha, task3Sha, tempDir, mergedTasks, 60_000);
    expect(culprit).toBeDefined();
    expect(culprit?.taskId).toBe("task-2");
  });
});
