import { z } from "zod";
import { CARD_KINDS, CARD_LIMITS, CARD_SOURCE_KINDS } from "@lane-pilot/contracts";
import { ToolError, type ServerCore } from "../../../contracts/server";
import { registerObservedTool } from "../../../platform/server";
import { getCard, listCards, setCard, verifyCard } from "../services/cards";

const cardKind = z.enum(CARD_KINDS);
const cardSourceKind = z.enum(CARD_SOURCE_KINDS);
const projectRef = z.string().min(1).max(200);

export const cardToolParams = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    kind: cardKind,
    key: z.string().trim().min(1).max(120),
    content: z.string().trim().min(1).max(CARD_LIMITS.chars * 4),
    sourceKind: cardSourceKind.optional(),
    sourceRef: z.string().trim().max(500).optional(),
    global: z.boolean().optional(),
    projectId: projectRef.optional(),
    ttlDays: z.number().positive().max(3650).optional(),
  }).strict(),
  z.object({
    action: z.literal("get"),
    cardId: z.string().min(1).max(128).optional(),
    kind: cardKind.optional(),
    key: z.string().trim().min(1).max(120).optional(),
    global: z.boolean().optional(),
    projectId: projectRef.optional(),
  }).strict(),
  z.object({
    action: z.literal("verify"),
    cardId: z.string().min(1).max(128),
    by: z.string().trim().min(1).max(80).optional(),
    ref: z.string().trim().max(500).optional(),
    ttlDays: z.number().positive().max(3650).optional(),
  }).strict(),
  z.object({
    action: z.literal("list"),
    kind: cardKind.optional(),
    global: z.boolean().optional(),
    includeGlobal: z.boolean().optional(),
    projectId: projectRef.optional(),
  }).strict(),
]);

function resolveScopeProjectId(
  callerProjectId: string | undefined,
  requestedProjectId: string | undefined,
  global: boolean | undefined,
): string | null {
  if (global) return null;
  if (requestedProjectId && callerProjectId && requestedProjectId !== callerProjectId) {
    throw new ToolError("card projectId does not match this thread's project", {
      code: "project_mismatch",
      retryable: false,
      sideEffects: "none",
    });
  }
  const resolved = requestedProjectId ?? callerProjectId;
  if (!resolved) {
    throw new ToolError("card requires a projectId or global: true", {
      code: "missing_project",
      retryable: false,
      sideEffects: "none",
    });
  }
  return resolved;
}

export function mountCardTool(ctx: ServerCore): void {
  const json = (value: unknown) => JSON.stringify(value, null, 2);

  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_card",
    description: "Store, read, verify, or list typed knowledge cards (niche, brand, contact, platform) in hub memory.",
    instructions:
      "Knowledge cards hold business/niche facts as data with TTL and source trust. URL/run sources stay observed until owner verify.",
    parameters: cardToolParams,
    execute: async (input, context) => {
      switch (input.action) {
        case "set": {
          const projectId = resolveScopeProjectId(context.projectId, input.projectId, input.global);
          const sourceKind = input.sourceKind ?? "owner";
          const sourceRef = input.sourceRef ?? (context.threadId ? `thread:${context.threadId}` : "pm");
          try {
            return json(
              setCard(ctx, {
                projectId,
                kind: input.kind,
                key: input.key,
                content: input.content,
                source: { kind: sourceKind, ref: sourceRef },
                ttlDays: input.ttlDays,
              }),
            );
          } catch (cause) {
            throw new ToolError(cause instanceof Error ? cause.message : String(cause), {
              code: "card_refused",
              retryable: false,
              sideEffects: "none",
            });
          }
        }
        case "get": {
          if (input.cardId) {
            const card = getCard(ctx, { cardId: input.cardId });
            if (card && card.projectId !== null && context.projectId && card.projectId !== context.projectId) {
              throw new ToolError("card belongs to another project", {
                code: "project_mismatch",
                retryable: false,
                sideEffects: "none",
              });
            }
            return json({ card });
          }
          if (!input.kind || !input.key) {
            throw new ToolError("get needs cardId, or both kind and key", {
              code: "bad_input",
              retryable: false,
              sideEffects: "none",
            });
          }
          const projectId = resolveScopeProjectId(context.projectId, input.projectId, input.global);
          return json({ card: getCard(ctx, { projectId, kind: input.kind, key: input.key }) });
        }
        case "verify": {
          try {
            return json(
              verifyCard(ctx, {
                cardId: input.cardId,
                by: input.by ?? "owner",
                ref: input.ref,
                ttlDays: input.ttlDays,
              }),
            );
          } catch (cause) {
            throw new ToolError(cause instanceof Error ? cause.message : String(cause), {
              code: "card_refused",
              retryable: false,
              sideEffects: "none",
            });
          }
        }
        case "list": {
          const projectId = resolveScopeProjectId(context.projectId, input.projectId, input.global);
          return json({
            cards: listCards(ctx, {
              projectId,
              kind: input.kind,
              includeGlobal: input.includeGlobal,
            }),
          });
        }
      }
    },
  });
}
