import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/plugin-db";
import { storeMemoryRecords } from "../../packages/memory-core/src";
import type { MemoryCandidate, MemoryDatabase, MemoryTrust } from "../../packages/memory-core/src";
import { compileMainAgentProfile } from "../../src/rooms/native-agent/agent-profile";
import { roleProfilePolicy } from "../../src/rooms/contracts/helper-context";
import { agentRequest } from "../../src/rooms/workflow/server/workflow-agent";
import { runSim } from "../workflow/chain-harness";

// The last tails of the SMA map (cross-region): n1230 (region 16, /sma-sketch) and n1362 (region 16, the memory preview of the project start).
// The observations tests/sma/four-proofs-tails-last.test.ts asserts; scripts/lp_drill/scenes/sma_tails_last_probe.ts runs the same functions for the scene.

/** What the designer is launched with, in its own chat and as a specialist the PM or a graph starts. */
export function observeSketch() {
  const chat = compileMainAgentProfile("design-lead").skills ?? [];
  const specialist = roleProfilePolicy("specialist:design-lead").skills?.names ?? [];
  const copyChat = compileMainAgentProfile("copy-lead").skills ?? [];
  return { chat, specialist, copyChat };
}

export const NOTE_STACK = "The stack is TypeScript with vitest; the test command is npm test and it is green on main; deploy and logs go through the hosts profile.";
const NOTE_OTHER = "The stack is Python with pytest; the test command is make test; deploy and logs go through the hosts profile of another project.";
const NOTE_GUESS = "Maybe the test command of the stack is yarn test; deploy probably goes through the hosts profile.";

function put(db: MemoryDatabase, projectId: string, trust: MemoryTrust, content: string) {
  const entry: MemoryCandidate = { kind: "note", content, concepts: ["stack"] };
  return storeMemoryRecords(db, { projectId, sourceSha256: "b".repeat(64), audience: "subagent", coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999, trust, origin: "session", entries: [entry] }).insertedIds;
}

/** The brief the «Stack, tests, memory preview» step of project-start is given, run on the real engine with a hub database holding notes. */
export async function observeMemoryPreview() {
  const host = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host.bb);
  put(db, "P", "confirmed", NOTE_STACK);
  put(db, "Q", "confirmed", NOTE_OTHER);
  put(db, "P", "observed", NOTE_GUESS);
  const count = () => (db.prepare("SELECT count(*) AS n FROM lane_pilot_memory").get() as { n: number }).n;
  const before = count();
  let prompt = "";
  const capture = (ctx: StepContext) => {
    const withHub = Object.create(ctx, { runtime: { value: { ctx: { db }, projectId: "P", pmThreadId: null, runId: null } } }) as StepContext;
    prompt = agentRequest(withHub as never, ctx.node as never).prompt;
    return {};
  };
  await runSim("project-start", { input: { goal: "start the project" }, stubs: { preview: capture } });
  const block = /<project_memory>\n([\s\S]*?)\n<\/project_memory>/.exec(prompt)?.[1] ?? null;
  return { block: block === null ? null : block.split("\n"), written: count() - before };
}
