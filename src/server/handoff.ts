import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildCapabilityRegistry,
  chooseRecipient,
  createHandoff,
  describeRegistry,
  expireOverdueHandoffs,
  extractHandoffReceiptBlock,
  getHandoff,
  handoffBudgetSchema,
  handoffInputSchema,
  handoffMessage,
  handoffReceiptSchema,
  HANDOFF_STATES,
  listHandoffEvents,
  listHandoffs,
  parseHandoffReceipt,
  recordHandoffReceipt,
  transitionHandoff,
  type AgentDefinition,
  type StoredHandoff,
} from "@lane-pilot/handoff";
import bundledAgents from "../bundled-agents.json";
import { BB_AGENT_SUMMARIES } from "../native-agent-overlay";
import { requirePmRun, type ServerContext } from "./context";
import { registerObservedTool } from "./tool-result";
import { scheduleIsolated } from "./schedules";
import { sendServiceMessage } from "./service-message";

export const HANDOFF_TOOLS = ["lane_pilot_handoff_create", "lane_pilot_handoff_receipt", "lane_pilot_handoff_list"] as const;

type BundledAgent = { displayName?: string; prompt?: string; skills?: string[]; tools?: string[] };

export function bundledAgentDefinitions(): AgentDefinition[] {
  return Object.entries(bundledAgents as Record<string, BundledAgent>).map(([id, agent]) => ({
    id, displayName: agent.displayName, description: BB_AGENT_SUMMARIES[id], prompt: agent.prompt, skills: agent.skills, tools: agent.tools,
  }));
}

function view(stored: StoredHandoff) {
  const { card, receipt, lease } = stored;
  return { id: card.id, state: card.state, fromAgent: card.fromAgent, toAgent: card.toAgent, title: card.title, recipientThreadId: card.recipientThreadId, deadlineAt: card.deadlineAt, receipt, lease, updatedAt: card.updatedAt };
}

const createParams = z.object({
  runId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4000),
  acceptance: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  toAgent: z.string().trim().min(1).max(120).optional(),
  request: z.string().trim().min(1).max(2000).optional(),
  inputs: z.array(handoffInputSchema).max(50).default([]),
  budget: handoffBudgetSchema.default({}),
  deadlineMinutes: z.number().int().min(1).max(24 * 60).optional(),
  recipientThreadId: z.string().min(1).optional(),
  fromAgent: z.string().trim().min(1).max(120).default("lane-pilot-pm"),
}).strict();

/**
 * Handoffs between agents as cards with receipts. A card is delivered into a BB thread when the
 * caller names one; otherwise the caller carries the card text to its own subagent and reports the
 * receipt itself.
 */
export function mountHandoff(ctx: ServerContext, options: { agents?: AgentDefinition[] } = {}): void {
  const { bb, db } = ctx;
  const registry = buildCapabilityRegistry(options.agents ?? bundledAgentDefinitions());

  registerObservedTool(bb.agents, {
    name: "lane_pilot_handoff_create",
    description: "Give a task to another agent as a typed card: objective, acceptance, inputs, budget, deadline. Returns the card text to deliver and its id.",
    instructions: [
      "Use from the active Lane Pilot PM thread. Name `toAgent`, or describe the work in `request` and the recipient is chosen from the agent registry.",
      "With `recipientThreadId` the card is sent into that thread and marked delivered. Without it, pass the returned `message` to your own subagent and report its final output with lane_pilot_handoff_receipt.",
      `Known agents:\n${describeRegistry(registry)}`,
    ].join("\n"),
    parameters: createParams,
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      let toAgent = params.toAgent;
      let chosenBy: "caller" | "registry" = "caller";
      if (!toAgent) {
        const choice = chooseRecipient(registry, params.request ?? `${params.title} ${params.objective}`);
        if (!choice) throw new Error("no agent matches the request; name toAgent explicitly");
        toAgent = choice.agentId;
        chosenBy = "registry";
      }
      const now = Date.now();
      const stored = createHandoff(db, {
        id: `hnd_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        projectId: context.projectId,
        runId: params.runId,
        ownerThreadId: context.threadId,
        draft: {
          fromAgent: params.fromAgent, toAgent, title: params.title, objective: params.objective, acceptance: params.acceptance,
          inputs: params.inputs, budget: params.budget, deadlineAt: params.deadlineMinutes ? now + params.deadlineMinutes * 60_000 : null,
        },
        now,
      });
      const message = handoffMessage(stored.card);
      const recipientThreadId = params.recipientThreadId ?? context.threadId;
      if (params.recipientThreadId) {
        await sendServiceMessage(bb, { threadId: params.recipientThreadId, text: message, senderThreadId: context.threadId });
      }
      const delivered = transitionHandoff(db, { id: stored.card.id, to: "delivered", actor: "lane-pilot", recipientThreadId, now: Date.now() });
      if (!delivered.ok) throw new Error(`handoff ${stored.card.id} could not be marked delivered: ${delivered.reason}`);
      return JSON.stringify({ handoff: view(delivered.handoff), chosenBy, deliveredTo: params.recipientThreadId ?? "caller", message }, null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_handoff_receipt",
    description: "Record the recipient's answer for a handoff: a receipt object, or the recipient's final output that ends with the receipt JSON block.",
    instructions: "Use from the active Lane Pilot PM thread. Pass `receipt` when you have the parsed object, or `output` with the recipient's full final message.",
    parameters: z.object({
      runId: z.string().min(1),
      handoffId: z.string().min(1),
      receipt: handoffReceiptSchema.optional(),
      output: z.string().min(1).max(200_000).optional(),
      actor: z.string().trim().min(1).max(120).optional(),
    }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const stored = getHandoff(db, params.handoffId);
      if (!stored || stored.card.runId !== params.runId) throw new Error("handoff does not belong to this run");
      let receipt = params.receipt;
      if (!receipt) {
        const block = params.output ? extractHandoffReceiptBlock(params.output, params.handoffId) : null;
        if (!block) throw new Error("no receipt block for this handoff in the output; ask the recipient to end with the JSON block");
        receipt = parseHandoffReceipt(block);
      }
      const result = recordHandoffReceipt(db, { id: params.handoffId, receipt, actor: params.actor ?? stored.card.toAgent });
      if (!result.ok) throw new Error(`receipt refused: ${result.reason}${result.from ? ` from ${result.from}` : ""}`);
      return JSON.stringify({ handoff: view(result.handoff), events: listHandoffEvents(db, params.handoffId) }, null, 2);
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_handoff_list",
    description: "List handoffs of this run or project with their states, leases and receipts.",
    instructions: "Use from the active Lane Pilot PM thread.",
    parameters: z.object({
      runId: z.string().min(1),
      scope: z.enum(["run", "project"]).default("run"),
      states: z.array(z.enum(HANDOFF_STATES)).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).strict(),
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const rows = listHandoffs(db, { projectId: context.projectId, runId: params.scope === "run" ? params.runId : undefined, states: params.states, limit: params.limit });
      return JSON.stringify({ handoffs: rows.map(view) }, null, 2);
    },
  });

  scheduleIsolated(bb, "handoff-expiry", "1-59/5 * * * *", async () => {
    if (ctx.isDisposed()) return;
    const expired = expireOverdueHandoffs(db);
    if (expired.length) ctx.log(`Lane Pilot handoffs expired: ${expired.join(", ")}`);
  }, { timeoutMs: 2 * 60_000 });
}
