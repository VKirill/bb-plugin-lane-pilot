import { describe, expect, it } from "vitest";
import { noteProviderLimit, resolveSpawnModel, seenProviderLimit, SEEN_LIMIT_HOLD_MS, type SpawnUsageUse } from "../src/rooms/platform/server/spawn-model";

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
