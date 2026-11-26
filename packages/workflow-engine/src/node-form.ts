import { z } from "zod";
import { NODE_FORMS, NODE_FORM_FALLBACKS, type NodeForm, type NodeFormFallback } from "@lane-pilot/contracts";
import type { Expr } from "./expr";

/**
 * Runtime-neutral schemas and fallback chain helpers for node execution forms (`agent | plan | script`).
 * Only the evolution gate (Task 20) may promote/change a node's declared `form`.
 */

export const nodeFormSchema = z.enum(NODE_FORMS);
export const nodeFormFallbackSchema = z.enum(NODE_FORM_FALLBACKS);

export const scriptConfigSchema = z.object({
  cmd: z.string().min(1).max(500).optional(),
  args: z.array(z.string().max(1000)).max(64).optional(),
  command: z.string().min(1).max(2000).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().min(1).max(500).optional(),
  fingerprint: z.string().min(1).max(256).optional(),
  timeoutSec: z.number().int().min(1).max(3600).optional(),
}).strict();
export type ScriptConfig = z.infer<typeof scriptConfigSchema>;

export const planConfigSchema = z.union([
  z.string().min(1).max(12_000),
  z.object({
    steps: z.array(z.string().min(1).max(2000)).min(1).max(50).optional(),
    template: z.string().min(1).max(12_000).optional(),
    summary: z.string().max(1000).optional(),
    provider: z.string().max(64).optional(),
    model: z.string().max(120).optional(),
    reasoning: z.enum(["low", "medium", "high", "xhigh", "ultracode", "max"]).optional(),
  }).strict().superRefine((val, ctx) => {
    if ((!val.steps || val.steps.length === 0) && !val.template) {
      ctx.addIssue({ code: "custom", message: "plan requires steps or template" });
    }
  }),
]);
export type PlanConfig = z.infer<typeof planConfigSchema>;

export const verifyObjectSchema = z.object({
  expr: z.union([z.string().min(1).max(600), z.array(z.string().min(1).max(600)).min(1).max(10)]).optional(),
  cmd: z.string().min(1).max(500).optional(),
  args: z.array(z.string().max(1000)).max(64).optional(),
  command: z.string().min(1).max(2000).optional(),
  cwd: z.string().min(1).max(500).optional(),
  requiredFields: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
}).strict().superRefine((val, ctx) => {
  if (val.expr === undefined && val.cmd === undefined && val.command === undefined && val.requiredFields === undefined) {
    ctx.addIssue({ code: "custom", message: "verify must specify expr, cmd/command, or requiredFields" });
  }
  if (val.cmd && val.command) {
    ctx.addIssue({ code: "custom", message: "verify cannot set both cmd and command" });
  }
});
export type VerifyObject = z.infer<typeof verifyObjectSchema>;

/** Ordered form chain for an agent node: drops one level per failure (`script -> plan -> agent`). */
export function formChainOf(node: {
  form?: NodeForm;
  fallback?: NodeFormFallback;
  plan?: PlanConfig;
}): NodeForm[] {
  const form: NodeForm = node.form ?? "agent";
  if (form === "agent") return ["agent"];
  if (form === "plan") return ["plan", "agent"];
  if (node.fallback === "agent") return ["script", "agent"];
  if (node.fallback === "plan" || node.plan !== undefined) return ["script", "plan", "agent"];
  return ["script", "agent"];
}

/** Formats the fallback chain taken during a step (null when the initial form succeeded). */
export function formatFallbackChain(attempted: readonly NodeForm[]): string | null {
  return attempted.length > 1 ? attempted.join("->") : null;
}

/** Rewrites bare field references in a node's `verify` expression (`ok == true` -> `nodeId.ok == true`). */
export function normalizeVerifyExpr(
  expr: Expr,
  nodeId: string,
  fieldNames: ReadonlySet<string>,
  knownNodeIds: ReadonlySet<string>,
): Expr {
  switch (expr.t) {
    case "ref": {
      const ref = expr.ref;
      if (ref.kind === "node" && ref.node && ref.node !== nodeId && !knownNodeIds.has(ref.node) && fieldNames.has(ref.node)) {
        return { t: "ref", ref: { kind: "node", node: nodeId, path: [ref.node, ...ref.path] } };
      }
      return expr;
    }
    case "not":
      return { t: "not", e: normalizeVerifyExpr(expr.e, nodeId, fieldNames, knownNodeIds) };
    case "list":
      return { t: "list", items: expr.items.map((item) => normalizeVerifyExpr(item, nodeId, fieldNames, knownNodeIds)) };
    case "bin":
      return {
        ...expr,
        l: normalizeVerifyExpr(expr.l, nodeId, fieldNames, knownNodeIds),
        r: normalizeVerifyExpr(expr.r, nodeId, fieldNames, knownNodeIds),
      };
    default:
      return expr;
  }
}
