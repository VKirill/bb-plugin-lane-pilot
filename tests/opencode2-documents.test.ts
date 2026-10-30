import { describe, expect, it } from "vitest";
import { noteProviderStartFailure, noteProviderStartSuccess, providerBlockedForFolder, PROVIDER_FOLDER_BLOCK_TTL_MS, readProviderFolderBlock, resolveSpawnModel } from "../src/rooms/core/server/spawn-model";

// Mac mini 2026-10-30: opencode2's serve had no Documents access and its start EPERM'd; the owner re-granted it and the
// static path rule outlived the cause. Now only an observed refusal holds the provider out of ~/Documents, for a TTL.
const DOCUMENTS = "/Users/vechkasov/Documents/site";

function fakeKv() {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: never) => { if (value === null) map.delete(key); else map.set(key, value); },
  };
}

const EPERM = "Command thread.start failed: vk_required_session_policy_unenforceable_mcp_servers (EPERM /api/mcp 500)";

describe("an observed provider refusal in a ~/Documents folder", () => {
  it("without a recorded failure the provider is offered as usual", async () => {
    const kv = fakeKv();
    expect(await readProviderFolderBlock(kv, "macmini", "opencode2")).toBeNull();
    expect(providerBlockedForFolder("opencode2", DOCUMENTS, null)).toBeNull();
    expect(providerBlockedForFolder("opencode2", DOCUMENTS)).toBeNull();
  });

  it("a recorded EPERM refusal blocks it on that machine in that folder, only", async () => {
    const kv = fakeKv();
    await noteProviderStartFailure(kv, "macmini", "opencode2", DOCUMENTS, EPERM);
    const block = await readProviderFolderBlock(kv, "macmini", "opencode2");
    expect(block?.reason).toBe(EPERM);
    expect(providerBlockedForFolder("opencode2", DOCUMENTS, block)).toBe(EPERM);
    // Other folder, other provider, other machine: free.
    expect(await readProviderFolderBlock(kv, "macmini", "claude-code")).toBeNull();
    expect(await readProviderFolderBlock(kv, "macbook", "opencode2")).toBeNull();
    expect(providerBlockedForFolder("opencode2", "/Users/vechkasov/Work/x", block)).toBeNull();
  });

  it("a non-folder failure is not recorded; a successful start clears the block; an expired block is gone", async () => {
    const kv = fakeKv();
    await noteProviderStartFailure(kv, "macmini", "opencode2", DOCUMENTS, "some unrelated error");
    expect(await readProviderFolderBlock(kv, "macmini", "opencode2")).toBeNull();
    await noteProviderStartFailure(kv, "macmini", "opencode2", "/Users/vechkasov/Work/x", EPERM);
    expect(await readProviderFolderBlock(kv, "macmini", "opencode2")).toBeNull();

    await noteProviderStartFailure(kv, "macmini", "opencode2", DOCUMENTS, EPERM);
    expect(await readProviderFolderBlock(kv, "macmini", "opencode2")).not.toBeNull();
    await noteProviderStartSuccess(kv, "macmini", "opencode2", DOCUMENTS);
    expect(await readProviderFolderBlock(kv, "macmini", "opencode2")).toBeNull();

    await noteProviderStartFailure(kv, "macmini", "opencode2", DOCUMENTS, EPERM);
    const old = await readProviderFolderBlock(kv, "macmini", "opencode2", -1);
    expect(old).toBeNull();
  });

  it("the resolver takes the role's next provider only while a block stands", async () => {
    const kv = fakeKv();
    const base = { role: "analyst", settings: {}, envPath: DOCUMENTS, hostId: "macmini" };
    const unblocked = resolveSpawnModel(base as never);
    await noteProviderStartFailure(kv, "macmini", "opencode2", DOCUMENTS, EPERM);
    const folderBlock = await readProviderFolderBlock(kv, "macmini", "opencode2");
    const blocked = resolveSpawnModel({ ...base, folderBlock } as never);
    if (unblocked.providerId === "opencode2") expect(blocked.providerId).not.toBe("opencode2");
    else expect(blocked.providerId).toBe(unblocked.providerId);
  });
});
