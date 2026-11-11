import { redactKnown } from "@lane-pilot/kit";
import { list, rec, need, stringList } from "./workflow-chain-runtime";
import { agentPrompt, outputContract, outputFields } from "@lane-pilot/workflow-engine";
import type { Field, GraphNode, NodeExecutor, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { keyedSpawnSupported } from "../../platform/server";
import { withResolvedModel } from "./workflow-agent";
import type { WorkflowAgents } from "./workflow-agent";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";

// ---------------------------------------------------------------- actions that go through a helper thread (skills, MCP, accounts)

/** The delegated actions: each runs in an errand helper thread with its skills and its instructions, the way errands do. */
export function registerDelegatedActions(engine: WorkflowEngine, ctx: ServerCore, agents: WorkflowAgents): void {
  const { bb } = ctx;

  const DELEGATED: Record<string, { role: string; skills: string[]; how: string }> = {
    "telegram.send_rich": { role: "errand", skills: ["telegram-user", "telegram-rich-messages"], how: "Send the markdown as a Telegram rich message from the owner's account to `target` with the telegram-user skill (`tg rich-send --execute`). The send has receipts: never repeat it blindly, and if the first attempt may have gone through, read the chat before you try again. Report the message id, its link and the status the receipt gives." },
    "shell.skill_script": { role: "errand", skills: [], how: "Run the named script of the named skill with the given args, from the skill's own folder, and report the fields below from what it printed. Do not run any other script." },
    "shell.repo_script": { role: "errand", skills: [], how: "Run the named script of the repository (and only it) with the args and env given, from the repository root, and report the fields below. A deploy script has its own gates: report them, never bypass them." },
    "deploy.post_check": { role: "errand", skills: ["browser-automation"], how: "Check that the deployment works as the rule says and report ok with details (what you ran and saw)." },
    "lp.preflight": { role: "errand", skills: [], how: "Check the repository state the rule lists with read-only commands and report each field as you found it. Change nothing." },
    "lp.project_checks": { role: "errand", skills: [], how: "Run the project's own check commands (its test script and linter, as the project documents them; the gate detection notes of the project if there are any) and report the counts. Change nothing." },
  };
  for (const [key, spec] of Object.entries(DELEGATED)) {
    engine.register<ChainRuntime>(key, {
      get reentrant() { return keyedSpawnSupported(bb); },
      run: async (c) => {
        const rt = need(c);
        const node = c.node as Extract<GraphNode, { type: "action" }>;
        const fields = outputFields(c.workflow, node) as Field[];
        const params = rec(c.template(node.params));
        const reads = Object.fromEntries(list(rec(node).reads).map(String).map((ref) => [ref, c.resolve(ref)]));
        const title = `${key}${node.title ? `: ${node.title.en}` : ""}`;
        const prompt = agentPrompt({ workflow: c.workflow.id, node: node.id, title, role: "errand", mode: c.mode, readOnly: key === "lp.preflight",
          task: `${spec.how}\n\nAction: ${key}\nParameters: ${redactKnown(JSON.stringify(params))}`, inputs: { ...c.input.with, ...reads }, contract: outputContract(fields),
          skills: [...spec.skills, ...stringList(params.skill)] });
        const result = await agents.run(await withResolvedModel({ rt, workflowRunId: c.runId, workflowId: c.workflow.id, stepKey: c.stepKey, nodeId: node.id, spawnKey: c.spawnKey, role: spec.role, title, prompt, fields, skills: [...spec.skills, ...stringList(params.skill)], signal: c.signal }));
        return { output: result.output, threadId: result.threadId, ...(result.usage ? { usage: result.usage } : {}) };
      },
    } as NodeExecutor<ChainRuntime>);
  }
}
