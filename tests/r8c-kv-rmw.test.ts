import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { FRUSTRATION_KEY, recordFrustration, type FrustrationRecord } from "../src/rooms/learning/frustration";
import type { Kv } from "../src/rooms/learning/ops";
import { HOOK_TIMEOUTS_KEY, mountHookTimeoutWatch, type HookTimeoutRecord } from "../src/rooms/stability/server/hook-timeouts";
import type { ServerCore } from "../src/rooms/contracts/server";

const NOW = 1_800_000_000_000;
const frustration = (over: Partial<FrustrationRecord> = {}): FrustrationRecord => ({
  at: NOW, projectId: "proj_1", threadId: "thr_pm", messageId: "thr_pm:5:0", p: 0.8,
  quote: "this is broken", agentSaid: null, pmThreadId: "thr_pm", runId: "lprun_1", ...over,
});

describe("R8c: a kv read failure must not masquerade as an empty read-modify-write base", () => {
  it("recordFrustration: a storage error rejects instead of overwriting the frustration history", async () => {
    const history = [frustration({ messageId: "thr_old:1:0", threadId: "thr_old" })];
    const map = new Map<string, unknown>([[FRUSTRATION_KEY, history]]);
    const kv = {
      get: async <T,>() => { throw new Error("kv down"); },
      set: async (key: string, value: unknown) => { map.set(key, value); },
    } as unknown as Kv;
    await expect(recordFrustration(kv, frustration())).rejects.toThrow("kv down");
    expect((map.get(FRUSTRATION_KEY) as FrustrationRecord[])[0]!.messageId).toBe("thr_old:1:0");
  });

  it("hook timeouts: a storage error rejects the record write instead of dropping earlier timeouts", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    let callback: ((event: Record<string, unknown>) => void | Promise<void>) | null = null;
    (bb as unknown as { vk: unknown }).vk = { experimental_vkOnHookTimeout: (cb: typeof callback) => { callback = cb; return { dispose() {} }; } };
    const earlier: HookTimeoutRecord = { hook: "messageDispatch", timeoutMs: 20_000, threadId: "thr_old", projectId: "proj_1", required: true, at: NOW, quiet: false };
    await bb.storage.kv.set(HOOK_TIMEOUTS_KEY, [earlier] as never);
    const realGet = bb.storage.kv.get.bind(bb.storage.kv);
    (bb.storage.kv as { get: unknown }).get = async (key: string) => {
      if (key === HOOK_TIMEOUTS_KEY) throw new Error("kv down");
      return realGet(key);
    };
    let chain: Promise<unknown> = Promise.resolve();
    const ctx = {
      bb, db: null, host: null, log: () => undefined, isDisposed: () => false,
      deployDrain: { status: () => ({ draining: false, inFlight: [] }) },
      serializedKv: <T,>(work: () => Promise<T>) => { const next = chain.then(work, work); chain = next.catch(() => undefined); return next; },
    } as unknown as ServerCore;
    expect(mountHookTimeoutWatch(ctx)).toBe(true);
    const cb = callback as ((event: Record<string, unknown>) => Promise<void>) | null;
    await expect(cb?.({ hook: "env", timeoutMs: 10_000, threadId: "thr_new", projectId: "proj_1", required: false })).rejects.toThrow("kv down");
    const kept = await realGet(HOOK_TIMEOUTS_KEY) as HookTimeoutRecord[] | undefined;
    expect(kept?.map((row) => row.threadId)).toEqual(["thr_old"]);
  });
});
