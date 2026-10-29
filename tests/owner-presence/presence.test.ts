import { describe, expect, it } from "vitest";
import { laneOwnedMetadata, presenceHold, readPresence } from "../../src/rooms/owner-presence";
import { createOwnerPresence, observeOwnerDispatch } from "../../src/rooms/owner-presence/server";
import { failureClass } from "../../src/rooms/runs/failure-class";

const NOW = Date.parse("2026-10-23T10:00:00Z");

describe("the owner at the keyboard (SMA D2-6)", () => {
  it("keeps the newest mark per provider over the machines and skips malformed files", () => {
    const presence = readPresence([
      { hostId: "h_mini", text: JSON.stringify({ "claude-code": { at: NOW - 60_000, host: "mini" } }) },
      { hostId: "h_book", text: JSON.stringify({ "claude-code": { at: NOW - 30_000, host: "book" }, codex: { at: NOW - 3_600_000 } }) },
      { hostId: "h_ovh", text: "not json" },
    ]);
    expect(presence).toEqual([{ providerId: "claude-code", at: NOW - 30_000, hostId: "h_book", host: "book" }, { providerId: "codex", at: NOW - 3_600_000, hostId: "h_book", host: null }]);
    expect(presenceHold("claude-code", presence, NOW)).toBe("owner_present:claude-code used by the owner 1 min ago on book");
    expect(presenceHold("codex", presence, NOW)).toBeNull();
    expect(presenceHold("opencode2", presence, NOW)).toBeNull();
  });

  it("a hold is a provider limit, like an open breaker: the chain moves on, the attempt is not the task's failure", () => {
    expect(failureClass("blocked", "writer_provider_unavailable:owner_present:claude-code used by the owner 1 min ago on mini")).toBe(failureClass("blocked", "writer_provider_unavailable:breaker_open:x"));
  });

  it("an owner message in a thread Lane Pilot did not start holds that provider; a lane thread does not", async () => {
    expect(laneOwnedMetadata({})).toBe(false);
    expect(laneOwnedMetadata({ role: "pm" })).toBe(true);
    expect(laneOwnedMetadata({ spawnId: "architect:1" })).toBe(true);
    const kv = new Map<string, string>();
    const metadata = new Map<string, unknown>([["thr_owner", {}], ["thr_pm", { role: "pm" }], ["thr_helper", { role: "errand", lanePilotRunId: "run_1" }]]);
    const bb = {
      log: { warn() {} },
      storage: { kv: {
        get: async (key: string) => kv.get(key) ?? null,
        set: async (key: string, value: string) => { kv.set(key, value); },
      } },
      sdk: { threads: { getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {} } },
    };
    const api = createOwnerPresence({ bb, log: () => undefined } as never).ownerPresence;
    const sent = (threadId: string, providerId: string, initiator: "user" | "agent" = "user", senderThreadId: string | null = null) => observeOwnerDispatch(bb as never, {
      initiator, senderThreadId, thread: { id: threadId }, requestedExecution: { providerId }, host: { id: "h_mini", name: "mini" },
    });
    await sent("thr_owner", "codex");
    expect(api.holds("codex")).toMatch(/^owner_present:codex used by the owner 0 min ago on mini$/);
    await sent("thr_pm", "claude-code");
    await sent("thr_helper", "opencode2");
    await sent("thr_owner", "claude-code", "agent");
    await sent("thr_owner", "claude-code", "user", "thr_other");
    expect(api.holds("claude-code")).toBeNull();
    expect(api.holds("opencode2")).toBeNull();
    const reloaded = createOwnerPresence({ bb, log: () => undefined } as never).ownerPresence;
    await reloaded.sweep();
    expect(reloaded.holds("codex")).toMatch(/^owner_present:codex/);
    expect(reloaded.current().find((row) => row.providerId === "codex")?.host).toBe("mini");
  });
});
