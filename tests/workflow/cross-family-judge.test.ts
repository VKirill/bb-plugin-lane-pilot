import { describe, expect, it } from "vitest";
import { withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/workflow-agent";
import { resolveAgentModel } from "../../src/rooms/workflow/server/workflow-agent-model";
import { roleModelKey } from "@lane-pilot/models";

const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
const sol = { providerId: "codex", model: "gpt-6.1-sol" };
const row = (model: string) => ({ model });

describe("the judge is of another family than the author, for every judge whose author is known", () => {
  it("the plan critic takes the peer of its table pick when the planner runs in the same family", () => {
    // The owner put the critic on Opus and the planner on Opus: the rule moves the critic to Sol.
    const settings = { [roleModelKey("plan-critic")]: row("claude-opus-5-5") };
    expect(resolveAgentModel({ role: "plan-critic", settings, pm: null, author: opus })).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", issues: ["crossed_family"] });
    // The default critic (Sol) against a Sol planner goes to Opus.
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null, author: sol })).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", issues: ["crossed_family"] });
    // Already another family, or no author known: the table stands.
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null, author: opus })).toMatchObject({ model: "gpt-6.1-sol", issues: [] });
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null })).toMatchObject({ model: "gpt-6.1-sol", issues: [] });
  });

  it("keeps the table's pick when the peer is not offered on the machine, and never touches a pinned run or an author", () => {
    const offered = (_: string, model: string) => model !== "claude-opus-5-5";
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null, author: sol, offered })).toMatchObject({ model: "gpt-6.1-sol", issues: [] });
    expect(resolveAgentModel({ role: "auditor", settings: {}, pm: null, author: sol, pinned: { model: "gpt-6.1-sol", provider: "codex" } })).toMatchObject({ model: "gpt-6.1-sol", source: "pinned" });
    expect(resolveAgentModel({ role: "planner", settings: {}, pm: null, author: opus })).toMatchObject({ model: "claude-opus-5-5", issues: [] });
  });

  it("withResolvedModel reads the model the planner ran on in the same Lane Pilot run and judges against it", async () => {
    const kv = new Map<string, unknown>();
    const rt = (settings: Record<string, unknown>, runId = "run1") => ({
      pmThreadId: "pm", projectId: "p", runId,
      ctx: {
        db: { prepare: () => ({ get: () => undefined }) },
        effectiveProjectSettings: async () => ({ values: settings }), ownedAgents: async () => ({}),
        bb: { storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } },
          sdk: { threads: { defaultExecutionOptions: async () => opus } } },
      },
      services: {},
    });
    const settings = { [roleModelKey("planner")]: row("gpt-6.1-sol") };
    const request = (role: string, wf: string, runId = "run1") => ({ rt: rt(settings, runId), workflowRunId: wf, stepKey: "s", nodeId: "n", spawnKey: "k", title: "t", prompt: "", fields: [], role }) as unknown as HelperRequest;
    // The owner set the planner to Sol: the critic (Sol by default) and, later, the auditor of the same run go to Opus.
    expect(await withResolvedModel(request("planner", "wf1"))).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
    expect(await withResolvedModel(request("plan-critic", "wf1"))).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
    expect(await withResolvedModel(request("auditor", "wf-later"))).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
    // No planner recorded for another run: the PM chat (Opus) is the author of the plan, so the Sol critic stays.
    expect(await withResolvedModel(request("plan-critic", "wf2", "run2"))).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
  });
});
