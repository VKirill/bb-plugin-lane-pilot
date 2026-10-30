import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { NONE, routeRecheck, routeWorkflow } from "../../src/rooms/workflow/route-workflow";
import { createJevRouterModel } from "../../src/rooms/workflow/route-model";
import { createJev, type JevAnswer, type JevClient } from "@lane-pilot/jev";
import type { RouterCard, RouterModel } from "@lane-pilot/workflow-engine";

const card = (id: string): RouterCard => ({
  id, name: { en: id, ru: id }, description: { en: `${id} works`, ru: `${id} работает` }, examples: { en: ["do it"], ru: ["сделай"] }, not_for: [], tags: [],
  inputs: [], outputs: [], requires: { skills: [], plugins: [], secrets: [], machines: [] } as unknown as RouterCard["requires"], score: 0.5, rules: [],
});
const input = { intent: "do the thing", candidates: [card("a"), card("b"), card("c")] };

const choiceA = (probabilities: Record<string, number>): JevAnswer => {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return { type: "choice", choice: top![0], probabilities, confidence: 0.9 };
};

/** A scripted client: one canned answer set per call, in order; answers are namespaced by the judge as `0::<question id>`. */
function scripted(states: Array<Record<string, JevAnswer>>) {
  const calls: Array<{ state: unknown }> = [];
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(req) {
      calls.push({ state: req.state });
      const raw = states[Math.min(calls.length - 1, states.length - 1)];
      const answers = Object.fromEntries(Object.entries(raw).map(([id, answer]) => [`0::${id}`, answer]));
      return { ok: true, answers: answers as never, model: "test", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, attempts: 1 };
    },
  };
  return { client, calls };
}
const ambiguous = { pick: choiceA({ a: 0.5, b: 0.45, c: 0.03, [NONE]: 0.02 }), too_broad: { type: "noul", noul: 0.3 } as JevAnswer };
const confident = { pick: choiceA({ a: 0.9, b: 0.1, [NONE]: 0.0 }), clear: { type: "noul", noul: 0.9 } as JevAnswer };

const database = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const ACTIVE = { "jev.modes": "route.recheck=active" };
const model = (jev: ReturnType<typeof createJev>, legacy: RouterModel | null = async () => ({ choice: "b", confidence: 90, pattern: "thread", rejected: [], questions: [] }), settings: Record<string, unknown> = ACTIVE) =>
  createJevRouterModel({ jev: () => jev, settings: async () => settings, legacy, projectId: "p", runId: "r" });

describe("route.recheck as the second System One pass", () => {
  it("a confident recheck decides without the helper thread", async () => {
    const { client, calls } = scripted([ambiguous, confident]);
    const db = database();
    let legacyUsed = false;
    const out = await model(createJev({ client, db }), async () => { legacyUsed = true; return { choice: "b", confidence: 90, pattern: "thread", rejected: [], questions: [] }; })(input);
    expect(legacyUsed).toBe(false);
    expect(out.choice).toBe("a");
    expect(out.pattern).toContain("jev-recheck");
    expect(calls).toHaveLength(2);
  });

  it("an unsure recheck still reaches the thread, and the receipt keeps only field names and sizes", async () => {
    const unsure = { pick: choiceA({ a: 0.6, b: 0.38, [NONE]: 0.02 }), clear: { type: "noul", noul: 0.9 } as JevAnswer };
    const { client } = scripted([ambiguous, unsure]);
    const db = database();
    const out = await model(createJev({ client, db }))(input);
    expect(out.pattern).toBe("thread");
    const receipt = db.prepare("SELECT fields_json FROM lane_pilot_jev_receipt WHERE judgment='route.recheck' ORDER BY id DESC LIMIT 1").get() as { fields_json: string };
    const fields = JSON.parse(receipt.fields_json) as Record<string, number>;
    expect(Object.keys(fields).sort()).toEqual(["first_choice", "request", "runner_up"]);
    expect(fields.request).toBe(JSON.stringify(input.intent).length);
    expect(Object.values(fields).every((v) => typeof v === "number")).toBe(true);
  });

  it("a machine text never reaches Jev: the request is not sent", async () => {
    for (const intent of ["[bb message from thread:thr_x] deploy it", "Workflow run wfrun_1 of issue-quick is succeeded.", "[system] nightly"]) {
      const { client, calls } = scripted([confident]);
      const out = await model(createJev({ client, db: database() }))({ ...input, intent });
      expect(calls).toHaveLength(0);
      expect(out.pattern).toBe("thread");
    }
  });

  it("a secret in the request never reaches the Jev API at all", async () => {
    const { client, calls } = scripted([{ pick: choiceA({ a: 0.9, b: 0.05, c: 0.03, [NONE]: 0.02 }), too_broad: { type: "noul", noul: 0.1 } as JevAnswer }]);
    const out = await model(createJev({ client, db: database() }))({ ...input, intent: "deploy it, the key is sk-live-abcdefghij1234567890" });
    expect(calls).toHaveLength(0);
    expect(out.pattern).toBe("thread");
  });

  it("the state builder passes only whitelisted fields, not foreign input", () => {
    const state = routeRecheck.stateBuilder({ request: "do it", top: { id: "a", name: "A", p: 0.5 }, second: null, ...({ foreign: "leak" } as object) }) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["first_choice", "request", "runner_up"]);
    expect("foreign" in state).toBe(false);
    const long = routeRecheck.stateBuilder({ request: "x".repeat(5000), top: { id: "a", name: "A", p: 0.5 }, second: null }) as { request: string };
    expect((long as { request: string }).request.length).toBeLessThanOrEqual(3000);
    expect((long as { request: string }).request.endsWith("…")).toBe(true);
  });
});
