import { describe, expect, it } from "vitest";
import { withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/workflow-agent";
import { resolveAgentModel } from "../../src/rooms/workflow/server/workflow-agent-model";
import { roleModelKey } from "@lane-pilot/models";

const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
const sol = { providerId: "codex", model: "gpt-6.1-sol" };
const gemini = { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high" };
const row = (model: string) => ({ model });

describe("the judge is of another family than the author, for every judge whose author is known", () => {
  it("the plan critic takes the peer of its table pick when the planner runs in the same family", () => {
    // The owner put the critic on Opus and the planner on Opus: the rule moves the critic to Sol.
    const settings = { [roleModelKey("plan-critic")]: row("claude-opus-5-5") };
    expect(resolveAgentModel({ role: "plan-critic", settings, pm: null, author: opus })).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", issues: ["crossed_family"] });
    // The owner put the critic on Sol and the planner on Sol: Opus.
    expect(resolveAgentModel({ role: "plan-critic", settings: { [roleModelKey("plan-critic")]: row("gpt-6.1-sol") }, pm: null, author: sol })).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", issues: ["crossed_family"] });
    // The default critic (Gemini) against a Gemini planner goes to Sol, the strongest of the other families.
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null, author: gemini })).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", issues: ["crossed_family"] });
    // Already another family (Claude or GPT author), or no author known: the table stands.
    for (const author of [opus, sol, null]) expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null, author }), JSON.stringify(author)).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", issues: [] });
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null })).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", issues: [] });
  });

  it("keeps the table's pick, and says its independence is not met, when the peer is not offered on the machine; never touches a pinned run or an author", () => {
    const offered = (_: string, model: string) => model !== "claude-opus-5-5";
    expect(resolveAgentModel({ role: "auditor", settings: {}, pm: null, author: sol, offered })).toMatchObject({ model: "gpt-6.1-sol", issues: ["same_family_judge"] });
    // A Gemini critic of Gemini work: Sol, else Opus when Sol is gone, else the Gemini stays and says it is not independent.
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null, author: gemini, offered: (_, model) => model !== "gpt-6.1-sol" })).toMatchObject({ model: "claude-opus-5-5", issues: ["crossed_family"] });
    expect(resolveAgentModel({ role: "plan-critic", settings: {}, pm: null, author: gemini, offered: (provider) => provider === "opencode2" })).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", issues: ["same_family_judge"] });
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
    const geminiPlanner = { [roleModelKey("planner")]: row("router9/ag/gemini-3.8-flash-high") };
    const request = (role: string, wf: string, runId = "run1") => ({ rt: rt(settings, runId), workflowRunId: wf, stepKey: "s", nodeId: "n", spawnKey: "k", title: "t", prompt: "", fields: [], role }) as unknown as HelperRequest;
    // The owner set the planner to Sol: the critic (Sol by default) and, later, the auditor of the same run go to Opus.
    expect(await withResolvedModel(request("planner", "wf1"))).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
    expect(await withResolvedModel(request("auditor", "wf-later"))).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
    // The plan critic is a Gemini: another family than the Sol planner already.
    expect(await withResolvedModel(request("plan-critic", "wf1"))).toMatchObject({ provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high" });
    // The planner is a Gemini: the critic of the same run goes to Sol.
    const withGeminiPlanner = (role: string, wf: string) => ({ ...request(role, wf, "run3"), rt: rt(geminiPlanner, "run3") }) as unknown as HelperRequest;
    expect(await withResolvedModel(withGeminiPlanner("planner", "wf3"))).toMatchObject({ provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high" });
    expect(await withResolvedModel(withGeminiPlanner("plan-critic", "wf3"))).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
    // No planner recorded for another run: the PM chat (Opus) is the author of the plan, so the Gemini critic stays.
    expect(await withResolvedModel(request("plan-critic", "wf2", "run2"))).toMatchObject({ provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high" });
  });
});
