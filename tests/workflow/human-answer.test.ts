import { describe, expect, it } from "vitest";
import { humanOutput } from "../../src/rooms/workflow/server/workflow-executors";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { loadWorkflowStore } from "../../src/rooms/storage/store";

/** Audit 2026-10-08, item 4: words typed without picking an option never become the first option (`deploy.approve` -> `deploy`). */
const APPROVALS: Array<[string, string]> = [["deploy", "approve"], ["x-to-telegram-digest", "approve_send"], ["reels", "approve_clips"], ["roadmap-driven", "approve"]];

describe("a free-text answer on a human step", () => {
  it.each(APPROVALS)("%s.%s: a remark that names no option decides nothing; an option named outright or clicked still works", async (workflow, id) => {
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES });
    const node = store.get(workflow)!.workflow.nodes.find((candidate) => candidate.id === id) as never;
    expect(humanOutput(node, { choiceIndex: null, text: "no, wait, do not do it yet" })).toBeNull();
    expect(humanOutput(node, { choiceIndex: null, text: "" })).toBeNull();
    const second = (humanOutput(node, { choiceIndex: 2, text: "" }) as Record<string, unknown>).answer_kind;
    const named = humanOutput(node, { choiceIndex: null, text: ` ${String(second).replace(/_/g, " ").toUpperCase()}! ` }) as Record<string, unknown>;
    expect(named.answer_kind).toBe(second);
    expect((humanOutput(node, { choiceIndex: null, text: "option 2" }) as Record<string, unknown>).answer_kind).toBe(second);
  });

  it("a node with a text kind takes the words as a text answer, never as a decision", () => {
    const node = { out: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["approved", "answered", "abort", "timeout"] }], options: [] } as never;
    expect(humanOutput(node, { choiceIndex: null, text: "use postgres" })).toEqual({ answer: "use postgres", answer_kind: "answered" });
    const approvalOnly = { out: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["approved", "deferred", "timeout"] }], options: [] } as never;
    expect(humanOutput(approvalOnly, { choiceIndex: null, text: "looks fine" })).toBeNull();
  });
});
