import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { FRUSTRATION_KEY, ONE_PER_THREAD_MS, frustrationReason, recordFrustration, type FrustrationRecord } from "../../src/rooms/learning/frustration";
import type { Kv } from "../../src/rooms/learning/ops";
import { NOW } from "./helpers";

const record = (over: Partial<FrustrationRecord> = {}): FrustrationRecord => ({
  at: NOW, projectId: "proj_1", threadId: "thr_pm", messageId: "thr_pm:5:0", p: 0.8, quote: "Меня это уже бесит, зачем ты опять так делаешь", agentSaid: "Готово, окно добавил.", pmThreadId: "thr_pm", runId: "lprun_1", ...over,
});
const store = () => { const map = new Map<string, unknown>(); return { map, kv: { get: async <T>(key: string) => map.get(key) as T | undefined, set: async (key: string, value: unknown) => { map.set(key, value); } } as unknown as Kv }; };

describe("annoyance as an incident (T6)", () => {
  it("keeps one record a day for a thread and never the same message twice", async () => {
    const s = store();
    expect(await recordFrustration(s.kv, record())).toBe(true);
    expect(await recordFrustration(s.kv, record())).toBe(false);
    expect(await recordFrustration(s.kv, record({ messageId: "thr_pm:6:0", at: NOW + 1_000 }))).toBe(false);
    expect(await recordFrustration(s.kv, record({ messageId: "thr_pm:7:0", at: NOW + ONE_PER_THREAD_MS + 1 }))).toBe(true);
    expect(await recordFrustration(s.kv, record({ messageId: "thr_other:1:0", threadId: "thr_other" }))).toBe(true);
    expect((s.map.get(FRUSTRATION_KEY) as unknown[]).length).toBe(3);
  });

  it("keeps the last fifty records", async () => {
    const s = store();
    for (let i = 0; i < 55; i++) await recordFrustration(s.kv, record({ messageId: `thr_${i}:1:0`, threadId: `thr_${i}` }));
    expect((s.map.get(FRUSTRATION_KEY) as FrustrationRecord[]).map((row) => row.threadId)[0]).toBe("thr_5");
  });

  it("tells the repair engineer what the owner wrote, what the agent said, and not to blame Lane Pilot by default", () => {
    const text = frustrationReason(record());
    expect(text).toContain("clearly frustrated");
    expect(text).toContain("Меня это уже бесит");
    expect(text).toContain("The agent had just said: «Готово, окно добавил.»");
    expect(text).toMatch(/If it is the agent's choice or the project's, change no code/);
    expect(frustrationReason(record({ quote: null, agentSaid: null }))).toContain("withheld because it touches private matters");
  });

  describe("in the self-repair watcher", () => {
    let dispose: (() => Promise<void> | void) | null = null;
    afterEach(async () => { await dispose?.(); dispose = null; });

    it("becomes an incident of kind owner with the thread and the reason, and raises nothing for a record the watcher has seen", async () => {
      const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
      await plugin(bb);
      dispose = () => harness.lifecycle.dispose();
      await bb.storage.kv.set(FRUSTRATION_KEY, [record({ at: Date.now() })] as never);
      const tick = await harness.behavior.callRpc("self_repair_tick", { dryRun: true, since: 0 }) as { incidents: number; signatures: string[] };
      expect(tick.incidents).toBeGreaterThanOrEqual(1);
      expect(tick.signatures.some((signature) => signature.startsWith("owner:"))).toBe(true);
      const later = await harness.behavior.callRpc("self_repair_tick", { dryRun: true, since: Date.now() + 60_000 }) as { signatures: string[] };
      expect(later.signatures.some((signature) => signature.startsWith("owner:"))).toBe(false);
    });
  });
});
