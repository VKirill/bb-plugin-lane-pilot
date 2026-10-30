import { describe, expect, it } from "vitest";
import { criticEditTrialSettle, criticEditWasRejected, criticPromptOf, criticPromptRollback } from "../src/rooms/critique/critic-edit";

const kv = () => { const map = new Map<string, unknown>(); return { get: async (k: string) => map.get(k), set: async (k: string, v: never) => { map.set(k, v); } }; };

describe("the critic-edit trial loop", () => {
  it("a passed bench candidate is written as the stage's prompt, with rollback", async () => {
    const store = kv();
    const adopted = await criticEditTrialSettle({ kv: store, stage: "code-critique", proposal: "v2 prompt", verdict: { passed: true, summary: "armB won" }, now: 1000 });
    expect(adopted).toMatchObject({ action: "adopt", version: 1 });
    expect(await criticPromptOf(store, "code-critique")).toBe("v2 prompt");
    // A second adopt keeps the previous version for rollback.
    await criticEditTrialSettle({ kv: store, stage: "code-critique", proposal: "v3 prompt", verdict: { passed: true, summary: "again" }, now: 2000 });
    expect(await criticPromptOf(store, "code-critique")).toBe("v3 prompt");
    expect(await criticPromptRollback(store, "code-critique", 3000)).toBe("v2 prompt");
    expect(await criticPromptOf(store, "code-critique")).toBe("v2 prompt");
  });

  it("a failed candidate is not written and lands in the rejected buffer", async () => {
    const store = kv();
    const retired = await criticEditTrialSettle({ kv: store, stage: "plan-critique", proposal: "bad prompt", verdict: { passed: false, summary: "armB lost" }, now: 500 });
    expect(retired.action).toBe("retire");
    expect(await criticPromptOf(store, "plan-critique")).toBeNull();
    expect(await criticEditWasRejected(store, "plan-critique", "bad prompt")).toBe(true);
    expect(await criticEditWasRejected(store, "plan-critique", "other")).toBe(false);
  });

  it("no comparison yet: wait, nothing stored either way", async () => {
    const store = kv();
    expect((await criticEditTrialSettle({ kv: store, stage: "code-critique", proposal: "p", verdict: null })).action).toBe("wait");
    expect(await criticPromptOf(store, "code-critique")).toBeNull();
    expect(await criticEditWasRejected(store, "code-critique", "p")).toBe(false);
  });
});
