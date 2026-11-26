import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, parseWorkflow } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/plugin-db";
import { registerHumanForm, workflowQuestionKey } from "../../src/rooms/workflow/server/services/workflow-human-form";
import type { ChainRuntime, ServerCore } from "../../src/rooms/contracts/server";
import type { OwnerAnswer } from "../../src/rooms/relay/server";
import type { WorkflowAgents } from "../../src/rooms/workflow/server/services/workflow-agent";

/**
 * A human step whose owner form was dismissed («Не сейчас») or timed out must not be re-asked on every poll of
 * `builtin:human`: the question moves to the owner's list once (`workflow_question` item, answered by `workflow-answer`),
 * while a valid answer still settles the step with no owner item at all.
 */
const PROJECT = "proj-human", PM = "thr_pm";
type Row = Record<string, unknown>;
type Settled = (answer: OwnerAnswer) => void | Promise<void>;

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const asks: Array<{ threadId: string; request: Row }> = [];
  const settles: Settled[] = [];
  const ownerAsk = {
    askInBackground: (threadId: string, request: Row, onSettled: Settled) => {
      asks.push({ threadId, request });
      settles.push(onSettled);
      return Promise.resolve(true);
    },
  };
  const ctx = { bb, db, log: () => {}, ownerAsk } as unknown as ServerCore;
  // The question-wording helper is not under test: it answers at once.
  const agents = { run: async () => ({ threadId: "helper-question", output: { question: "Ship it? The release waits for your word." }, text: "" }) } as unknown as WorkflowAgents;
  const engine = new WorkflowEngine({ db, harnessVersion: "test" });
  const rt: ChainRuntime = { ctx, services: {}, pmThreadId: PM, projectId: PROJECT, runId: null };
  registerHumanForm(engine, ctx, agents, { runtimeOf: () => rt });
  return { db, engine, rt, asks, settles, dispose: () => harness.lifecycle.dispose() };
}

const askWorkflow = (): Workflow => parseWorkflow({
  schemaVersion: 1,
  id: "human-no-reask",
  name: "Human no reask",
  description: { en: "A chain with one owner question", ru: "Цепочка с одним вопросом владельцу" },
  inputs: [{ name: "what", type: "string", required: false, default: "the release" }],
  outputs: [{ name: "kind", type: "string", required: false }],
  nodes: [
    { id: "ask", type: "human", role: "owner", question: "Ship it?", output: [{ name: "answer", type: "string" }, { name: "answer_kind", type: "enum", values: ["go", "fix", "abort", "timeout"] }], timeoutSec: 600 },
    { id: "done", type: "action", action: "emit", map: { kind: "ask.answer_kind" } },
  ],
  edges: [{ from: "start", to: "ask" }, { from: "ask", to: "done" }],
});

const waitFor = async (read: () => unknown) => { for (let tries = 0; tries < 400 && !read(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
const stepKeyOf = (db: ReturnType<typeof openDatabase>, runId: string) =>
  (db.prepare("SELECT step_key FROM lane_pilot_wf_step WHERE run_id=?").get(runId) as { step_key: string }).step_key;
const ownerItems = (db: ReturnType<typeof openDatabase>) =>
  db.prepare("SELECT key, source, kind, project_id, what, why, wake, state, actions_json FROM lane_pilot_owner_item ORDER BY created_at").all() as Row[];

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

describe("a human-step form the owner did not answer", () => {
  it.each(["user", "timeout"] as const)("settled as %s: the next polls open no second form and the question waits on the owner's list once", async (reason) => {
    const t = setup();
    disposers.push(t.dispose);
    const started = t.engine.start({ workflow: askWorkflow(), runtime: t.rt, link: { projectId: PROJECT } });
    await waitFor(() => t.asks.length === 1);
    expect(t.asks[0]!.threadId).toBe(PM);
    const stepKey = stepKeyOf(t.db, started.runId);

    await t.settles[0]!({ outcome: "cancelled", reason });
    await t.engine.poll();
    await t.engine.poll();

    expect(t.asks).toHaveLength(1);
    expect(t.engine.get(started.runId)?.status).toBe("waiting");
    const items = ownerItems(t.db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: workflowQuestionKey(started.runId, stepKey), source: "workflow", kind: "workflow_question",
      project_id: PROJECT, state: "open", wake: 1, what: expect.stringContaining("Ship it?"),
    });
    const actions = JSON.parse(String(items[0]!.actions_json)) as Array<{ id: string; rpc: { method: string; input: Row } }>;
    expect(actions.map((action) => action.id)).toEqual(["go", "fix", "abort"]);
    expect(actions[0]!.rpc).toMatchObject({ method: "workflow_answer", input: { runId: started.runId, stepKey, choice: "go" } });
  });

  it("a valid option answer resolves the step and posts no owner item", async () => {
    const t = setup();
    disposers.push(t.dispose);
    const started = t.engine.start({ workflow: askWorkflow(), runtime: t.rt, link: { projectId: PROJECT } });
    await waitFor(() => t.asks.length === 1);
    await t.settles[0]!({ outcome: "answered", choice: { id: "2", label: "fix" }, text: "tests first", line: "fix — tests first" });
    await waitFor(() => t.engine.get(started.runId)?.status === "succeeded");
    expect(t.engine.get(started.runId)).toMatchObject({ status: "succeeded", output: { kind: "fix" } });
    expect(t.asks).toHaveLength(1);
    expect(ownerItems(t.db)).toHaveLength(0);
  });
});
