import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TARGET_SHA } from "../../src/rooms/runs/constants";
import { addOwnershipEntry, newSnapshotId, ownershipLedgerPath, readOwnershipLedger, readSnapshot, saveSnapshot } from "../../src/rooms/native-install/ownership";
import { managedEngineDir } from "@lane-pilot/kit";
import { installStack } from "../../src/rooms/native-install/stack-ops";
import { hostId, makeHome, treeHash, exactDd77Fixture, incompatibleFallback, managedInstall } from "./coexistence-helpers";

// All tests below clone the exact dd77 fixture; without it (clean clone) they skip instead of crashing.
describe.skipIf(!exactDd77Fixture)("managed install transaction failure integrity", () => {
  it.each(["after-rename", "after-snapshot", "after-ledger-commit"] as const)("compensates and safely retries after %s", async (faultAt) => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    const claude = join(home, ".claude/settings.json");
    const openCode = join(home, ".config/opencode/opencode.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(claude, '{"env":{"KEEP":"yes"}}\n');
    await writeFile(openCode, '{"model":"user/model"}\n');
    const ordinaryBefore = { claude: await treeHash(claude), openCode: await treeHash(openCode) };
    let preexistingSnapshotIds: string[] = [];
    if (faultAt === "after-ledger-commit") {
      const existingSnapshotId = newSnapshotId();
      const configHash = await treeHash(openCode);
      if (!configHash) throw new Error("OpenCode fixture should have a hash");
      await saveSnapshot(home, {
        snapshotId: existingSnapshotId,
        manager: "opencode-config",
        path: openCode,
        operation: "connect",
        owner: "lane-pilot",
        beforeSha256: null,
        afterSha256: configHash,
        ownedValue: "./plugins/other.ts",
        sourceSha: TARGET_SHA,
      });
      await addOwnershipEntry(home, {
        manager: "opencode-config",
        path: openCode,
        ownedValue: "./plugins/other.ts",
        owner: "lane-pilot",
        afterSha256: configHash,
        snapshotId: existingSnapshotId,
        sourceSha: TARGET_SHA,
      });
      preexistingSnapshotIds = await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots"));
    }
    const ledgerBefore = await treeHash(ownershipLedgerPath(home));

    const failed = await managedInstall(home, fallback, faultAt);
    expect(failed.status, failed.reason ?? "").toBe("failed");
    expect(failed.reason).toContain("compensation completed");
    expect(failed.evidence).toEqual([]);
    expect((await readOwnershipLedger(home)).entries.filter((entry) => entry.manager === "managed-checkout")).toEqual([]);
    const snapshots = await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots")).catch(() => []);
    expect(snapshots).toEqual(preexistingSnapshotIds);
    expect(await treeHash(ownershipLedgerPath(home))).toBe(ledgerBefore);
    const engines = await readdir(join(home, ".agents/lane-pilot/engines")).catch(() => []);
    expect(engines.filter((name) => name.startsWith(TARGET_SHA))).toEqual([]);
    expect({ claude: await treeHash(claude), openCode: await treeHash(openCode) }).toEqual(ordinaryBefore);

    const retry = await managedInstall(home, fallback);
    expect(retry.status, retry.reason ?? "").toBe("ok");
    expect(retry.path).toContain("/.agents/lane-pilot/engines/");
    expect(retry.snapshotId).toBeTruthy();
    const entry = (await readOwnershipLedger(home)).entries.find((item) => item.path === retry.path);
    expect(entry?.snapshotId).toBe(retry.snapshotId);
    expect(await readSnapshot(home, retry.snapshotId!)).toMatchObject({ path: retry.path, afterSha256: retry.afterSha256 });
    expect({ claude: await treeHash(claude), openCode: await treeHash(openCode) }).toEqual(ordinaryBefore);
  }, 180_000);

  it("fails closed on malformed ownership metadata before rename and reports no false writes", async () => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    const ledger = ownershipLedgerPath(home);
    await mkdir(join(home, ".agents/lane-pilot/coexistence"), { recursive: true });
    await writeFile(ledger, "{invalid\n");
    const claude = join(home, ".claude/settings.json");
    const openCode = join(home, ".config/opencode/opencode.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(claude, '{"env":{"KEEP":"yes"}}\n');
    await writeFile(openCode, '{"model":"user/model"}\n');
    const ordinaryBefore = { claude: await treeHash(claude), openCode: await treeHash(openCode) };

    const receipt = await installStack({ requestedHostId: hostId, homeDir: home, localFallbackPath: fallback });
    expect(receipt.status).toBe("failed");
    expect(receipt.filesChanged).toEqual([]);
    expect(receipt.notes.join("\n")).toContain("Ownership metadata preflight failed");
    expect(receipt.notes.join("\n")).not.toContain("failed before a write");
    expect(await treeHash(managedEngineDir(TARGET_SHA, home))).toBeNull();
    expect(await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots")).catch(() => [])).toEqual([]);
    expect(await readFile(ledger, "utf8")).toBe("{invalid\n");
    expect({ claude: await treeHash(claude), openCode: await treeHash(openCode) }).toEqual(ordinaryBefore);
  }, 180_000);

  it("preserves a changed rollback path and retries at a fresh managed destination", async () => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    const failed = await managedInstall(home, fallback, "rollback-conflict", async (path) => {
      await writeFile(join(path, ".late-user-edit"), "preserve this concurrent edit\n", { flag: "wx" });
    });
    expect(failed.status).toBe("failed");
    expect(failed.reason).toContain("residual path(s)");
    expect(failed.reason).toContain("Rollback conflict");
    const orphan = failed.path;
    expect(await readFile(join(orphan, ".late-user-edit"), "utf8")).toBe("preserve this concurrent edit\n");
    const orphanBeforeRetry = await treeHash(orphan);
    expect(failed.evidence.some((item) => item.kind === "rollback-residual" && item.path === orphan && item.sha256 === orphanBeforeRetry)).toBe(true);
    expect((await readOwnershipLedger(home)).entries.filter((entry) => entry.path === orphan)).toEqual([]);
    expect(await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots")).catch(() => [])).toEqual([]);

    const retry = await managedInstall(home, fallback);
    expect(retry.status, retry.reason ?? "").toBe("ok");
    expect(retry.path).not.toBe(orphan);
    expect(await treeHash(orphan)).toBe(orphanBeforeRetry);
    expect((await readOwnershipLedger(home)).entries.some((entry) => entry.path === retry.path && entry.snapshotId === retry.snapshotId)).toBe(true);
  }, 180_000);
});
