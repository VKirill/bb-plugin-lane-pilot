import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRun, createTask, openDatabase } from "../src/rooms/plugin-db";
import {
  TASK_MANIFEST_SCHEMA, legacyReadCount, openTaskHome, placeTaskHome, readTaskFile, recordTaskFile, renderTaskManifest, resolveTaskFile, taskHomeRel,
  type TaskFileIo,
} from "../src/rooms/storage";
import { isPlanningPath, planningText } from "../src/rooms/contracts/planning-root";

/** A host's files as a map of absolute paths: what the task home writes and reads, nothing else. */
function memoryIo(files = new Map<string, string>()): TaskFileIo & { files: Map<string, string> } {
  return { files, read: async (path) => files.get(path) ?? null, write: async (path, content) => { files.set(path, content); } };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const BASE = "/srv/proj";

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "lprun_1", "proj_1", "bb", BASE);
  for (const id of ["t-a", "t-b", "t-old"]) createTask(db, { id, runId: "lprun_1", kind: "bb", contract: { project_cwd: BASE } });
  openTaskHome(db, { taskId: "t-a", projectId: "proj_1", runId: "lprun_1", basePath: BASE, hostId: "h1" });
  openTaskHome(db, { taskId: "t-b", projectId: "proj_1", runId: "lprun_1", basePath: BASE, hostId: "h1" });
  return { db, io: memoryIo() };
}
const producer = { node: "test" };

describe("task home manifest (docs/task-folder.md)", () => {
  it("records a file under .agents/tasks/<id>/ and renders lp.task-manifest/1 from the database", async () => {
    const { db, io } = setup();
    const file = await recordTaskFile(db, io, { taskId: "t-a", kind: "plan", name: "PLAN.md", content: "do X\n", producer, readers: ["pm-read"] });
    expect(file.absPath).toBe(`${BASE}/.agents/tasks/t-a/PLAN.md`);
    expect(io.files.get(file.absPath)).toBe("do X\n");
    const manifest = JSON.parse(io.files.get(`${BASE}/.agents/tasks/t-a/manifest.json`)!);
    expect(manifest).toMatchObject({ schema: TASK_MANIFEST_SCHEMA, task_id: "t-a", run_id: "lprun_1", files: [{ path: "PLAN.md", kind: "plan", sha256: sha("do X\n"), readers: ["pm-read"] }] });
    // The file is the database's rendering: the same rows render the same JSON.
    expect(renderTaskManifest(db, "t-a")).toEqual(manifest);
  });

  it("resolves by {task_id, kind}: a neighbour task's file of the same kind is never returned", async () => {
    const { db, io } = setup();
    await recordTaskFile(db, io, { taskId: "t-b", kind: "plan", name: "PLAN.md", content: "B\n", producer });
    expect(resolveTaskFile(db, "t-a", "plan")).toBeNull();
    await recordTaskFile(db, io, { taskId: "t-a", kind: "plan", name: "PLAN.md", content: "A\n", producer });
    expect(resolveTaskFile(db, "t-a", "plan")).toMatchObject({ repoPath: ".agents/tasks/t-a/PLAN.md", sha256: sha("A\n"), legacy: false });
    // A different kind under the same name is not the plan.
    expect(resolveTaskFile(db, "t-a", "research")).toBeNull();
  });

  it("T16: latest is the supersedes chain inside the task, not a time order of files", async () => {
    const { db, io } = setup();
    await recordTaskFile(db, io, { taskId: "t-a", kind: "writer-report", name: "attempts/a1/report.md", content: "one\n", attemptId: "a1", producer });
    await recordTaskFile(db, io, { taskId: "t-a", kind: "writer-report", name: "attempts/a2/report.md", content: "two\n", attemptId: "a2", producer });
    expect(resolveTaskFile(db, "t-a", "writer-report")?.path).toBe("attempts/a2/report.md");
    expect(resolveTaskFile(db, "t-a", "writer-report", { attemptId: "a1" })?.path).toBe("attempts/a1/report.md");
    const files = (renderTaskManifest(db, "t-a")!.files as Array<Record<string, unknown>>);
    expect(files.find((row) => row.path === "attempts/a2/report.md")).toMatchObject({ supersedes: "attempts/a1/report.md" });
    expect(files.find((row) => row.path === "attempts/a1/report.md")).toMatchObject({ superseded_by: "attempts/a2/report.md" });
  });

  it("a read is recorded in read_by with the sha the reader got", async () => {
    const { db, io } = setup();
    await recordTaskFile(db, io, { taskId: "t-a", kind: "plan", name: "PLAN.md", content: "A\n", producer });
    const read = await readTaskFile(db, io, { taskId: "t-a", kind: "plan", reader: "plan-critique" });
    expect(read?.text).toBe("A\n");
    const manifest = JSON.parse(io.files.get(`${BASE}/.agents/tasks/t-a/manifest.json`)!);
    expect(manifest.files[0].read_by).toEqual([expect.objectContaining({ node: "plan-critique", sha256: sha("A\n") })]);
  });

  it("T22: a task on the old layout reads items/<id>/PLAN.md by its exact name through legacy, and each read is counted", async () => {
    const { db, io } = setup();
    io.files.set(`${BASE}/.agents/plans/items/t-old/PLAN.md`, "old plan\n");
    // A neighbour's old-layout file must not be taken.
    io.files.set(`${BASE}/.agents/plans/items/t-b/PLAN.md`, "neighbour\n");
    expect(legacyReadCount(db)).toBe(0);
    const first = await readTaskFile(db, io, { taskId: "t-old", kind: "plan", reader: "pm-read" });
    expect(first).toMatchObject({ text: "old plan\n", legacy: true, repoPath: ".agents/plans/items/t-old/PLAN.md" });
    await readTaskFile(db, io, { taskId: "t-old", kind: "plan", reader: "plan-critique" });
    expect(legacyReadCount(db, { taskId: "t-old" })).toBe(2);
    // A task with a home never falls back to an old path, even when one exists for it.
    io.files.set(`${BASE}/.agents/plans/items/t-a/PLAN.md`, "stale\n");
    expect(await readTaskFile(db, io, { taskId: "t-a", kind: "plan", reader: "pm-read" })).toBeNull();
    expect(legacyReadCount(db)).toBe(2);
  });

  it("T6: placing the home into a worktree copies only that task's manifest-listed files", async () => {
    const { db, io } = setup();
    await recordTaskFile(db, io, { taskId: "t-a", kind: "plan", name: "PLAN.md", content: "A\n", producer });
    await recordTaskFile(db, io, { taskId: "t-b", kind: "plan", name: "PLAN.md", content: "B\n", producer });
    io.files.set(`${BASE}/.agents/tasks/t-a/stray.txt`, "not in the manifest\n");
    const wt = memoryIo();
    const placed = await placeTaskHome(db, io, wt, { taskId: "t-a", worktreePath: "/wt/a" });
    expect(placed.sort()).toEqual([".agents/tasks/t-a/PLAN.md", ".agents/tasks/t-a/manifest.json"]);
    expect([...wt.files.keys()].sort()).toEqual(["/wt/a/.agents/tasks/t-a/PLAN.md", "/wt/a/.agents/tasks/t-a/manifest.json"]);
  });

  it("refuses a name that leaves the home or overwrites the manifest, and a task without a home", async () => {
    const { db, io } = setup();
    await expect(recordTaskFile(db, io, { taskId: "t-a", kind: "plan", name: "../t-b/PLAN.md", content: "x", producer })).rejects.toThrow(/not a file name/);
    await expect(recordTaskFile(db, io, { taskId: "t-a", kind: "plan", name: "manifest.json", content: "x", producer })).rejects.toThrow(/not a file name/);
    await expect(recordTaskFile(db, io, { taskId: "t-old", kind: "plan", name: "PLAN.md", content: "x", producer })).rejects.toThrow(/old layout/);
    expect(taskHomeRel("../x")).toBeNull();
  });

  it("one root rule: the task home is not a planning path and planningText never moves it to the planning home", () => {
    expect(isPlanningPath(".agents/tasks/t-a/PLAN.md")).toBe(false);
    expect(planningText("read .agents/tasks/t-a/PLAN.md", "/home/plan")).toBe("read .agents/tasks/t-a/PLAN.md");
  });
});
