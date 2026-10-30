import { afterEach, describe, expect, it } from "vitest";
import { applyThreadRowStatus, bindThreadRowStatus, threadRowStatusOf } from "../src/rooms/runs/ui/thread-row-status";

describe("thread row status", () => {
  afterEach(() => bindThreadRowStatus(null));

  it("maps live work to a row status: blocked beats running, done clears", () => {
    expect(threadRowStatusOf([{ column: "running" }, { column: "blocked" }])?.tone).toBe("error");
    expect(threadRowStatusOf([{ column: "running" }, { column: "done" }])?.tone).toBe("running");
    expect(threadRowStatusOf([{ column: "done" }])).toBeNull();
    expect(threadRowStatusOf([])).toBeNull();
  });

  it("calls the vk setter when it is bound", () => {
    const calls: Array<{ threadId: string; status: unknown }> = [];
    bindThreadRowStatus((threadId, status) => calls.push({ threadId, status }));
    applyThreadRowStatus("t1", [{ column: "blocked" }]);
    applyThreadRowStatus("t1", []);
    expect(calls[0]).toMatchObject({ threadId: "t1", status: { tone: "error" } });
    expect(calls[1]).toEqual({ threadId: "t1", status: null });
  });

  it("is a no-op on a stock BB without the experimental surface", () => {
    expect(() => applyThreadRowStatus("t1", [{ column: "blocked" }])).not.toThrow();
  });
});
