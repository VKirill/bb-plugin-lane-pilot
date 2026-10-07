import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { migrations } from "../../src/database";
import { applyDraftOps, checkDraft, draftOpSchema, slugWorkflowId } from "../../src/workflow/draft";
import type { DraftOp } from "../../src/workflow/draft";
import { createDraftStore } from "../../src/workflow/draft-store";
import { runDraftTest, testCasesOf } from "../../src/workflow/draft-test";
import { parseWorkflow } from "../../src/workflow/validate";
import { BROWSER_DIGEST_STEPS } from "./architect-fixture";

function store() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  return { db, drafts: createDraftStore(db) };
}

const newDraft = (drafts: ReturnType<typeof store>["drafts"]) =>
  drafts.create({ projectId: "p1", threadId: "thr_1", scope: "global", name: "Browser digest", description: "Search the web, analyse documents, summarise, send to Telegram" });

describe("draft operations", () => {
  it("builds a workflow step by step: an unfinished draft is saved with its problems, the finished one is valid", () => {
    const { drafts } = store();
    const draft = newDraft(drafts);
    expect(draft).toMatchObject({ version: 1, status: "draft", workflowId: "browser-digest", scope: "global" });
    const first = drafts.patch(draft.id, BROWSER_DIGEST_STEPS[0]!);
    expect(first.ok && first.check.valid).toBe(false);
    if (!first.ok) throw new Error("patch refused");
    expect(first.check.problems.some((problem) => problem.level === "error")).toBe(true);
    expect(first.draft.version).toBe(2);

    let last = first;
    for (const ops of BROWSER_DIGEST_STEPS.slice(1)) {
      const next = drafts.patch(draft.id, ops);
      if (!next.ok) throw new Error(`patch refused: ${JSON.stringify(next)}`);
      last = next;
    }
    expect(last.check.problems.filter((problem) => problem.level === "error")).toEqual([]);
    expect(last.check).toMatchObject({ valid: true, nodes: 7 });
    expect(last.draft.version).toBe(1 + BROWSER_DIGEST_STEPS.length);
    expect(drafts.history(draft.id).map((row) => row.version)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(drafts.definitionAt(draft.id, 2)).toMatchObject({ inputs: expect.any(Array) });
  });

  it("surfaces validator problems with the node and what to fix", () => {
    const { drafts } = store();
    const draft = newDraft(drafts);
    const result = drafts.patch(draft.id, [
      ...BROWSER_DIGEST_STEPS[0]!,
      { op: "add_node", node: { id: "a", type: "agent", prompt: "x", out: [{ name: "n", type: "number" }] } },
      { op: "add_node", node: { id: "b", type: "action", action: "noop" } },
      { op: "add_edge", edge: { from: "start", to: "a" } },
      { op: "add_edge", edge: { from: "a", to: "b", when: "a.missing == 1" } },
      { op: "add_edge", edge: { from: "b", to: "end" } },
    ]);
    if (!result.ok) throw new Error("refused");
    expect(result.check.valid).toBe(false);
    const messages = result.check.problems.filter((problem) => problem.level === "error").map((problem) => `${problem.code}: ${problem.message}`);
    expect(messages.some((message) => message.startsWith("condition_field"))).toBe(true);
    expect(result.draft.status).toBe("draft");
  });

  it("refuses an operation that cannot be applied and saves nothing", () => {
    const { drafts } = store();
    const draft = newDraft(drafts);
    const before = drafts.get(draft.id)!;
    const refused = drafts.patch(draft.id, [
      { op: "add_node", node: { id: "a", type: "agent" } },
      { op: "add_node", node: { id: "a", type: "agent" } },
      { op: "add_edge", edge: { from: "a", to: "ghost" } },
      { op: "update_node", id: "nope", set: { prompt: "x" } },
      { op: "set_meta", set: { status: "published", nodes: [] } },
    ]);
    expect(refused).toMatchObject({ ok: false, reason: "refused" });
    if (refused.ok || !refused.refused) throw new Error("expected refusals");
    expect(refused.refused.map((item) => item.index)).toEqual([1, 2, 3, 4]);
    expect(refused.refused[1]!.reason).toContain('"ghost"');
    expect(drafts.get(draft.id)).toEqual(before);
    expect(drafts.patch("wfd_missing", [])).toMatchObject({ ok: false, reason: "not_found" });
    expect(drafts.patch(draft.id, [], { expectedVersion: 9 })).toMatchObject({ ok: false, reason: "version_conflict", currentVersion: 1 });
  });

  it("updates, removes and finds edges by index or by endpoints, and refuses an ambiguous one", () => {
    const base = { nodes: [{ id: "a", type: "action", action: "x" }, { id: "b", type: "action", action: "y" }], edges: [
      { from: "start", to: "a" }, { from: "a", to: "b", when: "a.v == 1" }, { from: "a", to: "b" },
    ] };
    const ambiguous = applyDraftOps(base, [{ op: "update_edge", edge: { from: "a", to: "b" }, set: { label: "l" } }]);
    expect(ambiguous).toMatchObject({ ok: false });
    const byWhen = applyDraftOps(base, [{ op: "update_edge", edge: { from: "a", to: "b", when: "a.v == 1" }, set: { label: "l" } }, { op: "remove_edge", edge: { index: 2 } }]);
    if (!byWhen.ok) throw new Error("refused");
    expect(byWhen.definition.edges).toEqual([{ from: "start", to: "a" }, { from: "a", to: "b", when: "a.v == 1", label: "l" }]);
    const cascade = applyDraftOps({ ...base, entry: "a" }, [{ op: "remove_node", id: "a" }]);
    if (!cascade.ok) throw new Error("refused");
    expect(cascade.definition).toMatchObject({ nodes: [{ id: "b" }], edges: [] });
    expect("entry" in cascade.definition).toBe(false);
    expect(applyDraftOps(base, [{ op: "remove_node", id: "a", cascade: false }])).toMatchObject({ ok: false });
    // The sentinel spellings name the same edge.
    const sentinel = applyDraftOps(base, [{ op: "remove_edge", edge: { from: "$start", to: "a" } }]);
    expect(sentinel).toMatchObject({ ok: true });
  });

  it("validates the shape of an operation and makes ids from names", () => {
    expect(draftOpSchema.safeParse({ op: "add_node" }).success).toBe(false);
    expect(draftOpSchema.safeParse({ op: "remove_edge", edge: { from: "a" } }).success).toBe(false);
    expect(draftOpSchema.safeParse({ op: "teleport" }).success).toBe(false);
    expect(slugWorkflowId("Сводка из X", "ab12")).toBe("workflow-ab12");
    expect(slugWorkflowId("  Weekly X digest!  ", "ab12")).toBe("weekly-x-digest");
    expect(checkDraft({ id: "x" }).valid).toBe(false);
  });
});

describe("draft tests on stubs", () => {
  const finished = () => {
    const { db, drafts } = store();
    const draft = newDraft(drafts);
    for (const ops of BROWSER_DIGEST_STEPS) {
      const result = drafts.patch(draft.id, ops);
      if (!result.ok) throw new Error("refused");
    }
    return { db, drafts, draft: drafts.get(draft.id)! };
  };

  it("reads the cases of the draft: the main one and its variants", () => {
    const { draft } = finished();
    const workflow = parseWorkflow(draft.definition);
    expect(testCasesOf(workflow).map((item) => item.id)).toEqual(["digest", "digest/blocked", "digest/declined"]);
    // A draft without a test gets one smoke case made from its inputs.
    const bare = parseWorkflow({ ...draft.definition, test: undefined });
    expect(testCasesOf(bare)).toMatchObject([{ id: "smoke", input: { query: "stub input.query", chat: "me" } }]);
  });

  it("runs every case on stubs through the real engine: path, outputs and the stubbed outside calls", async () => {
    const { db, draft } = finished();
    const workflow = parseWorkflow(draft.definition);
    const results = [];
    for (const testCase of testCasesOf(workflow)) results.push(await runDraftTest({ db, harnessVersion: "t" }, workflow, testCase));
    expect(results.map((result) => [result.caseId, result.green, result.status])).toEqual([["digest", true, "succeeded"], ["digest/blocked", true, "succeeded"], ["digest/declined", true, "succeeded"]]);
    expect(results[0]!.path).toEqual(["search", "analyze", "summarize", "approve", "send", "sent"]);
    expect(results[0]!.stubbed.map((item) => item.node)).toEqual(expect.arrayContaining(["search", "analyze", "summarize", "send"]));
    expect(results[0]!.stubbed.find((item) => item.node === "send")).toMatchObject({ type: "action", executor: "telegram.send_rich" });
    expect(results[1]!.path).toEqual(["search", "aborted"]);
    expect(results[0]!.runId).toMatch(/^wfrun_/);
  });

  it("is red when the run ends differently from the case, and says why", async () => {
    const { db, draft } = finished();
    const workflow = parseWorkflow(draft.definition);
    const [main] = testCasesOf(workflow);
    const wrongPath = await runDraftTest({ db, harnessVersion: "t" }, workflow, { ...main!, expectPath: ["search", "sent"] });
    expect(wrongPath.green).toBe(false);
    expect(wrongPath.failures[0]).toContain("is not the expected");
    const wrongOutput = await runDraftTest({ db, harnessVersion: "t" }, workflow, { ...main!, expectOutput: { status: "aborted" } });
    expect(wrongOutput.failures[0]).toContain("output status");
  });

  it("runs a draft with votes, which the engine runs since W3", async () => {
    const { db } = store();
    const workflow = parseWorkflow({
      id: "votes", name: "Votes", description: { en: "d", ru: "д" }, inputs: [], outputs: [],
      nodes: [
        { id: "fan", type: "parallel", for_each: ["a", "b"], child: { type: "agent", prompt: "x", votes: 3, out: [{ name: "v", type: "string" }] }, join: { policy: "all", out: [{ name: "v", type: "array" }] } },
        { id: "done", type: "action", action: "emit", map: {} },
      ],
      edges: [{ from: "start", to: "fan" }, { from: "fan", to: "done" }],
    });
    const result = await runDraftTest({ db, harnessVersion: "t" }, workflow, testCasesOf(workflow)[0]!);
    expect(result).toMatchObject({ green: true, status: "succeeded" });
  });

  it("records the tests of a version: tested only when all are green, and a later change takes it back to draft", async () => {
    const { db, drafts, draft } = finished();
    const workflow = parseWorkflow(draft.definition);
    const results = [];
    for (const testCase of testCasesOf(workflow)) results.push(await runDraftTest({ db, harnessVersion: "t" }, workflow, testCase));
    expect(drafts.recordTests(draft.id, draft.version, results)).toMatchObject({ status: "tested", testedVersion: draft.version, tests: { green: true } });
    const patched = drafts.patch(draft.id, [{ op: "update_node", id: "send", set: { maxAttempts: 2 } } as DraftOp]);
    expect(patched).toMatchObject({ ok: true, draft: { status: "draft" } });
    // Results for a version that is no longer current are not stored.
    expect(drafts.recordTests(draft.id, draft.version, results)).toMatchObject({ status: "draft", testedVersion: draft.version });
    const red = drafts.recordTests(draft.id, draft.version + 1, [{ ...results[0]!, green: false }]);
    expect(red).toMatchObject({ status: "draft", tests: { green: false } });
  });
});
