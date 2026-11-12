import { describe, expect, it } from "vitest";
import { failureClassCooldownMs } from "../src/rooms/contracts/failure-class";
import { loadWriterPin, noteWriterPair, writerPinKey } from "../src/rooms/writer/writer-model-pin";

const fakeKv = () => {
  const map = new Map<string, unknown>();
  return { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: unknown) => void map.set(k, v), map };
};

describe("the task's writer pair, pinned for its life (H-01)", () => {
  it("records the first pair, keeps it while the reason is a retry, moves it on a failure-class reason", async () => {
    const kv = fakeKv();
    const first = { providerId: "claude-code", model: "sonnet" };
    await noteWriterPair(kv, "r", "t", first, "initial");
    expect(await loadWriterPin(kv, "r", "t")).toMatchObject({ ...first, reason: "initial" });
    // A plain retry on the same pair writes nothing and keeps the original reason.
    await noteWriterPair(kv, "r", "t", first, "retry");
    expect(await loadWriterPin(kv, "r", "t")).toMatchObject({ reason: "initial" });
    // A provider failure moves the pin and records why.
    const next = { providerId: "codex", model: "gpt" };
    await noteWriterPair(kv, "r", "t", next, "failure_class:limit");
    expect(await loadWriterPin(kv, "r", "t")).toMatchObject({ ...next, reason: "failure_class:limit" });
    expect(writerPinKey("r", "t")).toBe("writer-pair:r:t");
  });
});

describe("per-class cooldown after an attempt (H-14)", () => {
  it("an unset table pauses merge 30 s, infra and dirty base 60 s, provider not at all; {} turns pauses off", () => {
    expect(failureClassCooldownMs("merge", {})).toBe(30_000);
    expect(failureClassCooldownMs("provider", {})).toBe(0);
    expect(failureClassCooldownMs("infra", {})).toBe(60_000);
    expect(failureClassCooldownMs("task", {})).toBe(0);
    expect(failureClassCooldownMs("merge", { "writer.class_cooldowns": "{}" })).toBe(0);
    expect(failureClassCooldownMs("task", { "writer.class_cooldowns": "{}" })).toBe(0);
    expect(failureClassCooldownMs("task", { "writer.class_cooldowns": "not json" })).toBe(0);
  });
  it("reads seconds per class, only for the class that failed, capped by writer.cooldown_max_ms", () => {
    const settings = { "writer.class_cooldowns": '{"provider":30,"task":5}' };
    expect(failureClassCooldownMs("provider", settings)).toBe(30_000);
    expect(failureClassCooldownMs("task", settings)).toBe(5_000);
    expect(failureClassCooldownMs("merge", settings)).toBe(0);
    expect(failureClassCooldownMs("provider", { ...settings, "writer.cooldown_max_ms": 10_000 })).toBe(10_000);
  });
});
