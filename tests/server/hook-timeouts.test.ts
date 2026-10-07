import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database";
import { HOOK_TIMEOUTS_KEY, mountHookTimeoutWatch, type HookTimeoutRecord } from "../../src/server/hook-timeouts";
import { createSelfRepair } from "../../src/server/self-repair";
import type { ServerCore } from "../../src/server/core";
import packageJson from "../../package.json";

type Callback = (event: Record<string, unknown>) => void | Promise<void>;

function setup(options: { vk?: boolean; draining?: boolean } = {}) {
  const spawns: Array<Record<string, unknown>> = [];
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle" }) as never,
      spawn: async (input: unknown) => { spawns.push(input as Record<string, unknown>); return { id: "thr_repair1" } as never; },
      // A VK build has the thread keys too: the spawn goes through them.
      experimental_vkFindByKey: async () => null,
      experimental_vkSpawnKeyed: async ({ key: _key, ...input }: Record<string, unknown>) => { spawns.push(input); return { thread: { id: "thr_repair1" }, reused: false }; } } } as never,
  });
  let callback: Callback | null = null;
  if (options.vk !== false) (bb as unknown as { vk: unknown }).vk = { experimental_vkOnHookTimeout: (cb: Callback) => { callback = cb; return { dispose() {} }; } };
  const db = openDatabase(bb);
  let chain: Promise<unknown> = Promise.resolve();
  const ctx = { bb, db, log: () => undefined, isDisposed: () => false, deployDrain: { status: () => ({ draining: options.draining === true, inFlight: [] }) },
    serializedKv: <T,>(work: () => Promise<T>) => { const next = chain.then(work, work); chain = next.catch(() => undefined); return next; } } as unknown as ServerCore;
  return { bb, ctx, db, fire: async (event: Record<string, unknown>) => { await callback?.(event); }, subscribed: () => callback !== null, spawns };
}

describe("hook timeouts (VK hook policy)", () => {
  it("declares the policy in the manifest: dispatch 20 s, env 10 s, env not required", () => {
    const vk = (packageJson as unknown as { vk: { hookPolicy: Record<string, Record<string, unknown>> } }).vk;
    expect(vk.hookPolicy.messageDispatch).toEqual({ timeoutMs: 20_000 });
    expect(vk.hookPolicy.contributeEnv).toEqual({ timeoutMs: 10_000 });
  });

  it("does nothing without the core function", () => {
    const test = setup({ vk: false });
    expect(mountHookTimeoutWatch(test.ctx)).toBe(false);
  });

  it("keeps a timeout in kv and self-repair reads it as an incident", async () => {
    const test = setup();
    let clock = Date.now() - 10 * 60_000;
    expect(mountHookTimeoutWatch(test.ctx, () => clock)).toBe(true);
    clock = Date.now();
    await test.fire({ hook: "contributeEnv", timeoutMs: 10_000, threadId: "thr_pm", projectId: "proj_real", required: false });
    const rows = await test.bb.storage.kv.get<HookTimeoutRecord[]>(HOOK_TIMEOUTS_KEY);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ hook: "contributeEnv", timeoutMs: 10_000, threadId: "thr_pm", quiet: false });
    const result = await createSelfRepair(test.ctx).tick({ since: 0 });
    expect(result.incidents).toBe(1);
    expect(result.signatures[0]).toContain("hook:");
    expect(test.spawns).toHaveLength(1);
    expect(String(test.spawns[0]!.prompt)).toContain("hook contributeEnv did not answer in 10000 ms: env not applied");
  });

  it("a timeout in the reload window is kept but is not an incident", async () => {
    const test = setup();
    mountHookTimeoutWatch(test.ctx);
    await test.fire({ hook: "messageDispatch", timeoutMs: 20_000 });
    const drained = setup({ draining: true });
    let clock = Date.now() - 10 * 60_000;
    mountHookTimeoutWatch(drained.ctx, () => clock);
    clock = Date.now();
    await drained.fire({ hook: "contributeEnv", timeoutMs: 10_000 });
    for (const one of [test, drained]) {
      expect((await one.bb.storage.kv.get<HookTimeoutRecord[]>(HOOK_TIMEOUTS_KEY))![0]!.quiet).toBe(true);
      expect((await createSelfRepair(one.ctx).tick({ since: 0 })).incidents).toBe(0);
    }
  });
});
