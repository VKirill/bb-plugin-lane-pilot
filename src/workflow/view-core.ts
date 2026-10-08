import type { z } from "zod";
import type { workflowViewSchema } from "../contracts";
import type { Condition } from "./schema";

/**
 * The parts of the graph view that need no schema code at runtime, so the browser bundle can use them (the draft view reads
 * workflows that are still being written and cannot go through the closed schema).
 */
export type WorkflowView = z.infer<typeof workflowViewSchema>;
export type ViewNode = WorkflowView["nodes"][number];
export type ViewEdge = WorkflowView["edges"][number];
export type NodeTone = ViewNode["tone"];

export const flat = (text: string) => text.replace(/\s+/g, " ").trim();
export const cut = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The colour family of an agent by what its role does: plan blue, build green, QA orange, review violet. */
export function roleTone(role: string | null | undefined): NodeTone {
  const name = (role ?? "").toLowerCase();
  if (/review|critic|judge|audit|verdict/.test(name)) return "review";
  if (/qa|test|check|verif|browser/.test(name)) return "qa";
  if (/plan|analy|research|read|search|scout|discover/.test(name)) return "plan";
  if (/build|writ|work|code|implement|fix|develop|edit/.test(name)) return "build";
  return "agent";
}

const OPS: Record<string, string> = { eq: "==", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", in: "in", notIn: "not in" };
const literal = (value: unknown) => (typeof value === "string" ? `'${value}'` : JSON.stringify(value));

/** A condition as the text an owner reads: `verdict == 'rework'`, `a && b`, `!(…)`. */
export function conditionText(when: Condition | string | undefined): string | null {
  if (when === undefined) return null;
  if (typeof when === "string") return flat(when);
  if ("all" in when) return when.all.map((part) => groupText(part)).join(" && ");
  if ("any" in when) return when.any.map((part) => groupText(part)).join(" || ");
  if ("not" in when) return `!(${conditionText(when.not)})`;
  if (when.op === "exists") return `${when.field} exists`;
  return `${when.field} ${OPS[when.op] ?? when.op} ${literal(when.value)}`;
}
const groupText = (part: Condition) => ("all" in part || "any" in part ? `(${conditionText(part)})` : conditionText(part)!);
