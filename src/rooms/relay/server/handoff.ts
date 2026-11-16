import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildCapabilityRegistry,
  chooseRecipient,
  createHandoff,
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
import { bundledAgents } from "../../contracts";
import { BB_AGENT_SUMMARIES } from "../../contracts/server";
import { requirePmRun, type ServerContext } from "../../platform/server";
import { registerObservedTool } from "../../platform/server";
import { scheduleIsolated } from "../../platform/server";
import type { ChildPmRequest, PrepareRecipient } from "../../contracts";
import { ToolError } from "../../contracts/server";

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
  title: z.string().trim().min(1).max(1000),
  objective: z.string().trim().min(1).max(4000),
  acceptance: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  toAgent: z.string().trim().min(1).max(120).optional(),
  request: z.string().trim().min(1).max(2000).optional(),
  inputs: z.array(handoffInputSchema).max(50).default([]),
  budget: handoffBudgetSchema.default({}),
  deadlineMinutes: z.number().int().min(1).max(24 * 60).optional(),
  recipientThreadId: z.string().min(1).optional(),
  targetProjectId: z.string().trim().min(1).optional(),
  targetSectionId: z.string().trim().min(1).optional(),
  targetHostId: z.string().trim().min(1).optional(),
  targetPath: z.string().trim().min(1).optional(),
  fromAgent: z.string().trim().min(1).max(120).default("lane-pilot-pm"),
}).strict().superRefine((value, ctx) => {
  if (value.targetProjectId && value.recipientThreadId) ctx.addIssue({ code: "custom", message: "name either recipientThreadId (an existing thread) or targetProjectId (a new PM chat), not both" });
  if ((value.targetHostId || value.targetPath) && (!value.targetProjectId || !value.targetHostId || !value.targetPath)) ctx.addIssue({ code: "custom", message: "targetHostId and targetPath require each other and targetProjectId" });
  if (value.targetSectionId && !value.targetProjectId) ctx.addIssue({ code: "custom", message: "targetSectionId needs targetProjectId" });
});

/**
 * Handoffs between agents as cards with receipts. A card is delivered into a BB thread when the
 * caller names one; otherwise the caller carries the card text to its own subagent and reports the
 * receipt itself.
 */
export function mountHandoff(ctx: ServerContext, options: { agents?: AgentDefinition[]; startChild?: (input: ChildPmRequest) => Promise<{ threadId: string }>; prepareRecipient?: PrepareRecipient } = {}): void {
  const { bb, db } = ctx;
  const registry = buildCapabilityRegistry(options.agents ?? bundledAgentDefinitions());

  registerObservedTool(bb.agents, {
    name: "lane_pilot_handoff_create",
    description: "Assign a card with objective, acceptance, inputs, budget and deadline. targetProjectId opens a child Pilot in any project; targetSectionId selects its section. Returns card and thread ids.",
    instructions: [
      "Active PM only. Name toAgent, or request describes the agent to select.",
      "recipientThreadId checks freshness first: unopened over 5 hours or reported cache expiry opens a replacement in the same project/section. Use deliveredTo for followups. Without a destination, carry the returned message to your subagent and record lane_pilot_handoff_receipt.",
      "targetProjectId opens an independent child Pilot without setup. targetSectionId selects its folder. For ambiguous folders, pass a listed targetHostId/targetPath pair. Use recipientThreadId for subsequent assignments to the same child; use relay ask/reply for questions. Keep the actual sender; human approvals remain human-only. Never substitute another project or folder after refusal.",
      `Known agents (ids; with only \`request\` the closest one is chosen): ${registry.map((agent) => agent.agentId).join(", ")}.`,
    ].join("\n"),
    parameters: createParams,
    execute: async (params, context) => {
      requirePmRun(db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      const target = params.targetProjectId;
      if (target) {
        if (!options.startChild) throw new Error("starting a child Pilot is not available in this host");
        if (params.toAgent && params.toAgent !== "lane-pilot-pm") throw new Error("targetProjectId opens a Pilot; use recipientThreadId for other agents");
      }
      let toAgent = params.toAgent ?? (target ? "lane-pilot-pm" : undefined);
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
      let message = handoffMessage(stored.card);
      let recipientThreadId = params.recipientThreadId ?? context.threadId;
      if (target) {
        message = `[Lane Pilot] This chat was opened by the Lane Pilot PM of project ${context.projectId} (thread ${context.threadId}) as an agent assignment. The card below is your brief; human confirmations are not delegated.\n\n${message}`;
        let opened: { threadId: string };
        try {
          opened = await options.startChild!({ projectId: target, parentThreadId: context.threadId, sectionId: params.targetSectionId, hostId: params.targetHostId, path: params.targetPath, title: params.title, handoffId: stored.card.id });
        } catch (cause) {
          transitionHandoff(db, { id: stored.card.id, to: "canceled", actor: "lane-pilot", note: `child setup or delivery failed in ${target}: ${cause instanceof Error ? cause.message : String(cause)}`, now: Date.now() });
          throw new ToolError(`could not complete child Pilot handoff in project ${target}: ${cause instanceof Error ? cause.message : String(cause)}. The handoff ${stored.card.id} is canceled.`, { code: "child_handoff_failed", retryable: false, sideEffects: "unknown", next: "Inspect the handoff and any returned child thread before retrying." });
        }
        recipientThreadId = opened.threadId;
        try {
          // Keep the sender strict: a rejected attribution must not become an anonymous assignment.
          await bb.sdk.threads.send({ threadId: recipientThreadId, senderThreadId: context.threadId, mode: "queue-if-active",
            input: [{ type: "text", text: message, mentions: [] }] });
        } catch (cause) {
          // A timeout may mean BB accepted the message. Keep the card open; never cancel or resend blindly.
          throw new ToolError(`handoff ${stored.card.id} delivery to @thread:${recipientThreadId} is unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}`, {
            code: "handoff_delivery_unknown", retryable: false, sideEffects: "unknown", next: "Inspect this child and handoff before any retry; do not create another child.",
          });
        }
      } else if (params.recipientThreadId) {
        try {
          recipientThreadId = options.prepareRecipient ? await options.prepareRecipient({ projectId: context.projectId, fromThreadId: context.threadId, toThreadId: params.recipientThreadId }) : params.recipientThreadId;
        } catch (cause) {
          // No assignment has been sent yet. An inert child may exist, so preserve the setup error and forbid blind retries.
          transitionHandoff(db, { id: stored.card.id, to: "canceled", actor: "lane-pilot", note: `recipient setup failed: ${String(cause)}`, now: Date.now() });
          throw new ToolError(`handoff ${stored.card.id} canceled before delivery: ${cause instanceof Error ? cause.message : String(cause)}`, {
            code: "recipient_setup_failed", retryable: false, sideEffects: "unknown", next: "Inspect recipient setup before retrying; no assignment was sent.",
          });
        }
        if (recipientThreadId !== params.recipientThreadId) message = `Continuation of @thread:${params.recipientThreadId}. This is a fresh Pilot chat; consult that history if needed.\n\n${message}`;
        try {
          await bb.sdk.threads.send({ threadId: recipientThreadId, senderThreadId: context.threadId, mode: "queue-if-active", input: [{ type: "text", text: message, mentions: [] }] });
        } catch (cause) {
          throw new ToolError(`handoff ${stored.card.id} delivery to @thread:${recipientThreadId} is unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}`, {
            code: "handoff_delivery_unknown", retryable: false, sideEffects: "unknown", next: "Inspect the recipient and handoff before retrying; do not create another child.",
          });
        }
      }
      const delivered = transitionHandoff(db, { id: stored.card.id, to: "delivered", actor: "lane-pilot", recipientThreadId, now: Date.now() });
      if (!delivered.ok) throw new Error(`handoff ${stored.card.id} could not be marked delivered: ${delivered.reason}`);
      return JSON.stringify({ handoff: view(delivered.handoff), chosenBy, deliveredTo: recipientThreadId === context.threadId ? "caller" : recipientThreadId, ...(target ? { targetProjectId: target } : {}), message }, null, 2);
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
