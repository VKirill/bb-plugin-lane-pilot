import { describe, expect, it } from "vitest";
import { liveBackupKey } from "../src/rooms/writer/server/start-live-folder";
import { resolveLiveBackupId } from "../src/rooms/writer/server/live-backup-evidence";

describe("live-folder backup binding", () => {
  it("resolves a continuation to the original backup", async () => {
    const seen: string[] = [];
    const result = await resolveLiveBackupId({ get: async (key) => { seen.push(key); return "attempt-first"; } }, "attempt-continuation");
    expect(result).toEqual({ backupId: "attempt-first" });
    expect(seen).toEqual([liveBackupKey("attempt-continuation")]);
  });

  it("uses only the validated attempt id for a legacy missing binding", async () => {
    await expect(resolveLiveBackupId({ get: async () => undefined }, "attempt-first")).resolves.toEqual({ backupId: "attempt-first" });
    await expect(resolveLiveBackupId({ get: async () => undefined }, "../unsafe")).resolves.toEqual({ state: "unknown", reason: "backup_binding_invalid" });
  });

  it("fails closed for malformed or unreadable bindings", async () => {
    await expect(resolveLiveBackupId({ get: async () => "../other-backup" }, "attempt-continuation")).resolves.toEqual({ state: "unknown", reason: "backup_binding_invalid" });
    await expect(resolveLiveBackupId({ get: async () => { throw new Error("store unavailable"); } }, "attempt-continuation")).resolves.toEqual({ state: "unknown", reason: "backup_binding_unreadable" });
  });
});
