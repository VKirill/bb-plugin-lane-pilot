import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { roleProfilePolicy } from "../src/rooms/native-agent/helper-context";
import { createWriterSkillPick, recordedWriterSkills, skillPickOn } from "../src/rooms/writer/server/skill-pick";

const LISTED = [
  { name: "writer-practices", description: "Lane-writer code style" },
  { name: "tavily", description: "Web search through the Tavily API" },
  { name: "three-js", description: "three.js scenes, cameras and materials" },
  { name: "ops-orchestrator", description: "Run agents, lanes and task contracts" },
  { name: "ru-text", description: "Russian text quality" },
];

const task = {
  schema_version: 2, id: "T1", title: "Build the scene", risk: "low", lane: "web", project_cwd: "/home/ubuntu/apps/ru-text",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/scene.ts"], owns_paths: ["src/scene.ts"],
  never_touch: [], depends_on: [], objective: "Draw the scene", acceptance: ["the scene renders"], verify: "tests", verification: [],
} as unknown as TaskV2;

/** Jev says «domain» for every skill except the agent-operations one, and «yes» only for the skills in `relevant`. */
function judge(relevant: string[]) {
  return async (input: Record<string, unknown>) => {
    const questions = input.questions as Record<string, { instructions: string; criteria: Record<string, string> }>;
    const answers: Record<string, Record<string, number>> = {};
    for (const [id, question] of Object.entries(questions)) {
      const name = /^Skill — (.+?): /.exec(question.instructions)![1]!;
      if ("domain" in question.criteria) answers[id] = { domain: name === "ops-orchestrator" ? 0.05 : 0.9, agent_ops: 0.1 };
      else answers[id] = { yes: relevant.includes(name) ? 0.8 : 0.05, no: 0.2 };
    }
    return { hostId: "h", status: "ok", answers: {}, probabilities: answers, reason: null };
  };
}

function world(options: { listed?: unknown; judge?: (input: Record<string, unknown>) => Promise<unknown>; deadlineMs?: number } = {}) {
  const judged: Array<Record<string, unknown>> = [];
  const kv = new Map<string, unknown>();
  let listCalls = 0;
  const logged: string[] = [];
  const bb = {
    sdk: {
      skills: { list: async () => { listCalls += 1; if (options.listed === "fail") throw new Error("skills offline"); return { skills: options.listed ?? LISTED }; } },
      files: { read: async () => null },
    },
    storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); } } },
    log: { info: (message: string) => logged.push(message) },
  };
  const host = {
    call: async (method: string, input: Record<string, unknown>) => {
      if (method !== "councilJudge") throw new Error(`unexpected host call ${method}`);
      judged.push(input);
      return (options.judge ?? judge(["three-js"]))(input);
    },
  };
  const pick = createWriterSkillPick({ bb, host } as never, { deadlineMs: options.deadlineMs, log: (message) => logged.push(message) });
  const run = (settings: Record<string, unknown> = {}, hints?: string[]) => pick.pick({
    attemptId: "a1", projectId: "p1", hostId: "h", projectCwd: "/home/ubuntu/apps/ru-text",
    task: hints ? { ...task, skills: hints } : task, plan: "Draw the scene with three.js", settings,
  });
  return { run, judged, logged, listCalls: () => listCalls, kv };
}

describe("writer skill pick", () => {
  it("gives the writer its role skills, the picks and the hints", async () => {
    const pick = await world().run({}, ["tavily"]);
    expect(pick.skills).toEqual(["ru-text", "three-js", "tavily"]);
    const policy = roleProfilePolicy("writer", {}, { skills: pick.skills });
    expect(policy.skills).toEqual({ mode: "allow", names: ["writer-practices", "karpathy-guidelines", "ru-text", "three-js", "tavily"] });
    expect(pick.reason).toBeNull();
  });

  it("records each pick with its probability", async () => {
    const pick = await world().run();
    expect(pick.picked).toEqual([{ name: "three-js", p: 0.8 }]);
    expect(recordedWriterSkills({ skillPick: pick })).toEqual(["ru-text", "three-js"]);
  });

  it("with the setting off gives the hints only and asks Jev nothing", async () => {
    const env = world();
    const pick = await env.run({ "writer.skill_pick": "off" }, ["tavily"]);
    expect(pick.skills).toEqual(["tavily"]);
    expect(env.judged).toEqual([]);
  });

  it("a Jev error adds no picks and leaves the writer its role skills", async () => {
    const pick = await world({ judge: async () => { throw new Error("System One is down"); } }).run();
    expect(pick.picked).toEqual([]);
    expect(pick.skills).toEqual(["ru-text"]);
    expect(roleProfilePolicy("writer", {}, { skills: pick.skills }).skills?.names).toEqual(["writer-practices", "karpathy-guidelines", "ru-text"]);
  });

  it("a failing skill list gives the writer its role skills and the reason", async () => {
    const pick = await world({ listed: "fail" }).run({}, ["tavily"]);
    expect(pick.skills).toEqual([]);
    expect(pick.reason).toBe("pick_error:skills offline");
  });

  it("a pick that runs past its deadline gives the writer its role skills, without waiting for Jev", async () => {
    const started = Date.now();
    const pick = await world({ deadlineMs: 30, judge: () => new Promise(() => undefined) }).run();
    expect(pick.reason).toBe("pick_timeout");
    expect(pick.skills).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("lists the skills once for ten minutes", async () => {
    const env = world();
    await env.run();
    await env.run();
    expect(env.listCalls()).toBe(1);
  });

  it("keeps the kind verdicts in plugin storage", async () => {
    const env = world();
    await env.run();
    expect([...env.kv.keys()].filter((key) => key.startsWith("writer-skill-kind:"))).toHaveLength(4);
  });

  it("is on unless the setting says off", () => {
    expect(skillPickOn(undefined)).toBe(true);
    expect(skillPickOn("on")).toBe(true);
    for (const off of ["off", false, "false", 0, "0"]) expect(skillPickOn(off), String(off)).toBe(false);
  });

  it("reads the skills a dispatch recorded, and nothing from a dispatch without them", () => {
    expect(recordedWriterSkills({ skillPick: { skills: ["ru-text", 3] } })).toEqual(["ru-text"]);
    expect(recordedWriterSkills(undefined)).toEqual([]);
    expect(recordedWriterSkills({})).toEqual([]);
  });
});
