import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { presenceHold, readPresence } from "../../src/rooms/owner-presence";
import { createOwnerPresence } from "../../src/rooms/owner-presence/server";
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

  it("the sweep reads every connected machine and keeps a machine's last marks when it does not answer", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", name: "mini", status: "connected" }, { id: "h2", name: "book", status: "connected" }, { id: "h3", name: "off", status: "offline" }]);
    let answer = true;
    const asked: string[] = [];
    const host = { call: async (_method: string, input: { requestedHostId?: string; hostId?: string }) => {
      const id = input.requestedHostId ?? input.hostId ?? "";
      asked.push(id);
      if (!answer && id === "h1") throw new Error("down");
      return { hostId: id, exitCode: 0, stdout: id === "h1" ? JSON.stringify({ "claude-code": { at: Date.now(), host: "mini" } }) : "{}", stderr: "" };
    } };
    const api = createOwnerPresence({ bb, host, log: () => undefined } as never).ownerPresence;
    await api.sweep();
    expect(api.holds("claude-code")).toMatch(/^owner_present:claude-code/);
    expect(asked).not.toContain("h3");
    answer = false;
    await api.sweep();
    expect(api.holds("claude-code")).toMatch(/^owner_present/);
  });
});
