import { describe, expect, it } from "vitest";
import { renderThreadEvents, trajectoryStats } from "../src/index";

const item = (seq: number, body: Record<string, unknown>) => ({ type: "item/completed", seq, data: { item: body } });

describe("renderThreadEvents", () => {
  it("renders the BB item kinds in the shared grammar, in sequence order", () => {
    const events = [
      item(5, { type: "commandExecution", id: "c1", command: "npx vitest run tests/a.test.ts", status: "completed", exitCode: 1, aggregatedOutput: "FAIL tests/a.test.ts\nexpected 2 to be 3" }),
      item(1, { type: "userMessage", id: "u1", content: [{ type: "text", text: "Workspace: /repo\nTask: fix the discount" }] }),
      item(2, { type: "reasoning", id: "r1", summary: ["Read the composable first"], content: [] }),
      item(3, { type: "fileRead", id: "f1", path: "apps/web/app/composables/useDiscount.ts", status: "completed" }),
      item(4, { type: "fileChange", id: "e1", status: "completed", changes: [{ path: "apps/web/app/composables/useDiscount.ts", kind: "update" }, { path: "tests/a.test.ts", kind: "add" }] }),
      item(6, { type: "toolCall", id: "t1", server: "gitnexus", tool: "impact", arguments: { target: "applyDiscount" }, status: "completed", result: { risk: "LOW" } }),
      item(7, { type: "mcpToolCall", id: "t2", tool: "query", status: "failed", error: "server unavailable" }),
      item(8, { type: "contextCompaction", id: "k1" }),
      { type: "provider/error", seq: 9, data: { message: "rate limit", willRetry: true } },
      { type: "turn/completed", seq: 10, data: { status: "interrupted" } },
      item(11, { type: "agentMessage", id: "a1", text: "Changed: apps/web/app/composables/useDiscount.ts, tests/a.test.ts" }),
      item(12, { type: "somethingNew", id: "x1", text: "future item kind" }),
    ];
    const out = renderThreadEvents(events);
    expect(out.split("\n")).toEqual([
      "[USER] Workspace: /repo\nTask: fix the discount".replace("\n", "\n"),
      "[REASONING] Read the composable first",
      "[ACTION] read: apps/web/app/composables/useDiscount.ts",
      "[ACTION] edit: apps/web/app/composables/useDiscount.ts (update), tests/a.test.ts (add)",
      "[ACTION] shell: npx vitest run tests/a.test.ts",
      "[OBSERVATION ERROR] FAIL tests/a.test.ts\nexpected 2 to be 3 | exit_code=1",
      '[ACTION] gitnexus/impact: {"target":"applyDiscount"}',
      '[OBSERVATION] {"risk":"LOW"}',
      "[ACTION] query: {}",
      "[OBSERVATION ERROR] server unavailable",
      "[HARNESS] context compacted",
      "[ERROR] provider: rate limit (retried)",
      "[HARNESS] turn ended: interrupted",
      "[ASSISTANT] Changed: apps/web/app/composables/useDiscount.ts, tests/a.test.ts",
      "[HARNESS] somethingNew: future item kind",
    ].join("\n").split("\n"));
    expect(trajectoryStats(out)).toEqual({ actions: 5, failedObservations: 2, errors: 1, userTurns: 1 });
  });

  it("clips one observation but never drops an event, and cuts the whole in the middle with a marker", () => {
    const long = "x".repeat(10_000);
    const one = renderThreadEvents([item(1, { type: "commandExecution", id: "c", command: "cat big", status: "completed", exitCode: 0, aggregatedOutput: long })], { obsTrunc: 100 });
    expect(one).toContain("[OBSERVATION] " + "x".repeat(100) + " …[+9900 chars clipped]");
    const many = Array.from({ length: 50 }, (_, i) => item(i, { type: "agentMessage", id: `a${i}`, text: `message ${i} ${"y".repeat(200)}` }));
    const cut = renderThreadEvents(many, { maxChars: 2000 });
    expect(cut.length).toBeLessThan(2400);
    expect(cut).toMatch(/\[HARNESS\] …renderer cut \d+ chars from the middle/);
    expect(cut.startsWith("[ASSISTANT] message 0")).toBe(true);
    expect(cut).toContain("message 49");
  });

  it("collapses identical consecutive lines and tolerates events without data", () => {
    const out = renderThreadEvents([item(1, { type: "fileRead", id: "a", path: "x.ts" }), item(2, { type: "fileRead", id: "b", path: "x.ts" }), { type: "turn/started" }, { seq: 3 }]);
    expect(out).toBe("[ACTION] read: x.ts");
  });
});
