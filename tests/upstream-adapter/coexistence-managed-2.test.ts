import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Buffer } from "@lane-pilot/kit";
import { makeHome, treeHash, exactDd77Fixture, incompatibleFallback, managedInstall } from "./coexistence-helpers";

// All tests below clone the exact dd77 fixture; without it (clean clone) they skip instead of crashing.
describe.skipIf(!exactDd77Fixture)("managed install transaction failure integrity", () => {
  it.each(["after-snapshot", "after-ledger-commit"] as const)("preserves complete concurrent snapshot bytes after %s", async (faultAt) => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    let editedBytes: Buffer | null = null;
    let snapshotFile = "";
    const failed = await managedInstall(home, fallback, faultAt, async (_managedPath, path) => {
      snapshotFile = path;
      const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      snapshot.createdAt = "late-user-edit-created-at";
      snapshot.note = { preserved: true, source: "concurrent writer" };
      editedBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
      await writeFile(path, editedBytes);
    });

    expect(failed.status, failed.reason ?? "").toBe("failed");
    expect(failed.reason).toContain("residual path(s)");
    expect(failed.reason).not.toContain("metadata compensation completed");
    expect(failed.snapshotId).toBeTruthy();
    expect(editedBytes).not.toBeNull();
    expect(await readFile(snapshotFile)).toEqual(editedBytes);
    const snapshotHash = sha256Buffer(editedBytes!);
    expect(failed.evidence.some((item) => item.kind === "rollback-residual" && item.path === snapshotFile && item.sha256 === snapshotHash)).toBe(true);

    const retainedEngine = failed.path;
    const retainedEngineHash = await treeHash(retainedEngine);
    expect(retainedEngineHash).not.toBeNull();
    expect(failed.evidence.some((item) => item.kind === "rollback-residual" && item.path === retainedEngine && item.sha256 === retainedEngineHash)).toBe(true);

    const retry = await managedInstall(home, fallback);
    expect(retry.status, retry.reason ?? "").toBe("ok");
    expect(retry.path).not.toBe(retainedEngine);
    expect(await treeHash(retainedEngine)).toBe(retainedEngineHash);
    expect(await readFile(snapshotFile)).toEqual(editedBytes);
  }, 180_000);

  it("captures and restores a replacement that races the snapshot claim", async () => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    let changedBytes: Buffer | null = null;
    let snapshotFile = "";
    const failed = await managedInstall(home, fallback, "after-snapshot", undefined, async (path) => {
      snapshotFile = path;
      const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      snapshot.createdAt = "replacement-race-created-at";
      snapshot.note = "replacement raced after the initial byte check";
      changedBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
      const replacement = `${path}.replacement`;
      await writeFile(replacement, changedBytes, { flag: "wx" });
      await rename(replacement, path);
    });

    expect(failed.status, failed.reason ?? "").toBe("failed");
    expect(failed.reason).toContain("replaced between the byte check and atomic claim");
    expect(changedBytes).not.toBeNull();
    expect(await readFile(snapshotFile)).toEqual(changedBytes);
    const changedHash = sha256Buffer(changedBytes!);
    expect(failed.evidence.some((item) => item.kind === "rollback-residual" && item.path === snapshotFile && item.sha256 === changedHash)).toBe(true);
    const snapshotsDir = join(home, ".agents/lane-pilot/coexistence/snapshots");
    expect(await readdir(snapshotsDir)).toEqual([`${failed.snapshotId}.json`]);

    const retainedEngine = failed.path;
    const retainedEngineHash = await treeHash(retainedEngine);
    expect(retainedEngineHash).not.toBeNull();
    expect(failed.evidence.some((item) => item.path === retainedEngine && item.sha256 === retainedEngineHash)).toBe(true);
    const retry = await managedInstall(home, fallback);
    expect(retry.status, retry.reason ?? "").toBe("ok");
    expect(retry.path).not.toBe(retainedEngine);
    expect(await treeHash(retainedEngine)).toBe(retainedEngineHash);
    expect(await readFile(snapshotFile)).toEqual(changedBytes);
  }, 180_000);
});
