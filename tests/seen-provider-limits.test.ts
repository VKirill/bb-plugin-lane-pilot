import { describe, expect, it } from "vitest";
import { noteProviderLimit, resolveSpawnModel, seenProviderLimit, SEEN_LIMIT_HOLD_MAX_MS, SEEN_LIMIT_HOLD_MS, type SpawnUsageUse } from "../src/rooms/platform/server/spawn-model";

// docs-night 2026-11-02..04: 157 units failed one after another on opencode2 GLM «Usage limit reached for 5 hour»; every
// unit picked the same spent model again. A limit seen once now takes that model's plan off every later helper pick.
// Seen limits are scoped to the plugin instance (the `bb` object): each test gets its own owner.
const GLM = { provider: "opencode2", model: "zai-coding-plan/glm-5.3-flash" };
const settings = { "role_model.docs-maintainer": GLM };

function ownerUsage(owner: object): SpawnUsageUse {
  return { peek: () => null, warm: async () => {}, seenLimit: (providerId, model) => seenProviderLimit(owner, providerId, model) };
}

describe("a provider limit seen in a helper's answer", () => {
  it("moves every later pick of the role off that plan, and only for the hold", () => {
    const owner = {};
    const usage = ownerUsage(owner);
    expect(resolveSpawnModel({ role: "docs-maintainer", settings, catalog: null, usage })).toMatchObject({ providerId: "opencode2", model: GLM.model });
    const now = Date.now();
    noteProviderLimit(owner, "opencode2", GLM.model, "Usage limit reached for 5 hour. Your limit will reset at 2026-11-04 13:11:20", now);
    const moved = resolveSpawnModel({ role: "docs-maintainer", settings, catalog: null, usage });
    expect(moved.model).not.toBe(GLM.model);
    expect(seenProviderLimit(owner, "opencode2", GLM.model, now + SEEN_LIMIT_HOLD_MS + 1)).toBeNull();
  });

  // 9router's Antigravity accounts, 2026-11-08..10: a weekly quota answered «HTTP 403 (reset after 2m)»; the hourly hold sent a
  // batch of docs-night threads into it every hour, each hanging 18 minutes before the fallback took the unit.
  it("is held twice as long each time the first try after the hold fails again, a day at most", () => {
    const owner = {}, flash = "router9/ag/gemini-3.8-flash-high", H = SEEN_LIMIT_HOLD_MS;
    let now = 1_000_000;
    expect(noteProviderLimit(owner, "opencode2", flash, "HTTP 403 (reset after 2m)", now)).toBe(H);
    // threads spawned before the hold fail inside it: the hold keeps its length
    expect(noteProviderLimit(owner, "opencode2", flash, "HTTP 403 (reset after 2m)", now += 18 * 60_000)).toBe(H);
    const holds: number[] = [];
    for (let i = 0; i < 6; i++) { const last = holds.at(-1) ?? H; holds.push(noteProviderLimit(owner, "opencode2", flash, "HTTP 403", now += last + 60_000)); }
    expect(holds).toEqual([2 * H, 4 * H, 8 * H, 16 * H, SEEN_LIMIT_HOLD_MAX_MS, SEEN_LIMIT_HOLD_MAX_MS]);
    expect(seenProviderLimit(owner, "opencode2", flash, now + SEEN_LIMIT_HOLD_MAX_MS - 1)).not.toBeNull();
    // a limit long after the last hold ended is a new one
    expect(noteProviderLimit(owner, "opencode2", flash, "HTTP 403", now += 3 * SEEN_LIMIT_HOLD_MAX_MS)).toBe(H);
  });

  it("a spent GLM plan does not take the free Gemini on the same opencode2 with it", () => {
    const owner = {};
    noteProviderLimit(owner, "opencode2", GLM.model, "Usage limit reached for 5 hour");
    expect(seenProviderLimit(owner, "opencode2", "zai-coding-plan/glm-5.1")).not.toBeNull();
    expect(seenProviderLimit(owner, "opencode2", "router9/ag/gemini-3.8-flash-high")).toBeNull();
    expect(seenProviderLimit(owner, "codex", "gpt-6-luna")).toBeNull();
  });
});

describe("a waited helper thread that failed", () => {
  it("is told to the failure listener with BB's cause, before the wait throws", async () => {
    const { onThreadFailure, waitThreadIdle } = await import("@lane-pilot/thread-observe");
    const bb = { sdk: { threads: {
      get: async () => ({ status: "error" }),
      events: { list: async () => [{ type: "turn/started", seq: 1 }, { type: "turn/completed", seq: 2, data: { status: "failed" } }] },
    } } } as never;
    const heard: string[] = [];
    onThreadFailure(bb, (threadId, detail) => heard.push(`${threadId} ${detail}`));
    await expect(waitThreadIdle(bb, "thr-1", "docs_nightly")).rejects.toThrow(/docs_nightly:error:thread_status_error/);
    expect(heard).toEqual([expect.stringMatching(/^thr-1 thread_status_error/)]);
  });
});
