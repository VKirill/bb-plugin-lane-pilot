import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Buffer } from "./hash";
import type { TaskV2 } from "./contracts";

export const ACCEPTANCE_V2_REQUIRED = [
  "schema_version",
  "task_id",
  "task_sha256",
  "attempt",
  "provider_exit",
  "report",
  "report_sha256",
  "owns_check",
  "verification",
  "review",
  "accepted",
  "accepted_at",
] as const;

const CLI_PROVIDERS = new Set(["agy", "grok", "codex", "qwen", "kimi", "cursor", "opencode"]);

export function loadAcceptanceV2Schema(): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "../lane-stack/schemas/acceptance-v2.schema.json"), "utf8")) as Record<string, unknown>;
}

export function acceptanceArtifactDir(workspace: string, runId: string, taskId: string): string {
  return `${workspace}/.agents/runs/${runId}/artifacts/${taskId}`;
}

export function bbWriterReportMarkdown(task: TaskV2, attempt: number): string {
  return [
    "STATUS: complete",
    "",
    `# ${task.title}`,
    "",
    task.objective,
    "",
    `Attempt ${attempt} accepted by Lane Pilot BB writer.`,
    "",
  ].join("\n");
}

export function buildAcceptanceV2(input: {
  task: TaskV2;
  attempt: number;
  providerId: string;
  model: string;
  reportText: string;
  review?: "passed" | "not_required";
  acceptedAt?: string;
}): Record<string, unknown> {
  const receipt: Record<string, unknown> = {
    schema_version: 2,
    task_id: input.task.id,
    task_sha256: sha256Buffer(JSON.stringify(input.task)),
    attempt: input.attempt,
    provider_exit: 0,
    report: "complete",
    report_sha256: sha256Buffer(input.reportText),
    owns_check: "passed",
    verification: "passed",
    review: input.review ?? "not_required",
    accepted: true,
    accepted_at: input.acceptedAt ?? new Date().toISOString(),
  };
  if (CLI_PROVIDERS.has(input.providerId)) receipt.provider = input.providerId;
  if (input.model.length > 0) receipt.model = input.model;
  return receipt;
}

export function validateAcceptanceV2(value: unknown): { ok:true } | { ok:false; errors:string[] } {
  const schema = loadAcceptanceV2Schema();
  const required = (schema.required as string[]) ?? [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok:false, errors:["(root): must be an object"] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of required) {
    if (!(key in record)) errors.push(`${key}: required`);
  }
  for (const key of Object.keys(record)) {
    if (!(key in properties)) errors.push(`${key}: additionalProperties is false`);
  }
  for (const [key, rule] of Object.entries(properties)) {
    if (!(key in record)) continue;
    const actual = record[key];
    if (rule.type === "string" && typeof actual !== "string") errors.push(`${key}: must be string`);
    if (rule.type === "integer" && (!Number.isInteger(actual))) errors.push(`${key}: must be integer`);
    if (rule.type === "boolean" && typeof actual !== "boolean") errors.push(`${key}: must be boolean`);
    if (rule.const !== undefined && actual !== rule.const) errors.push(`${key}: must equal ${String(rule.const)}`);
    if (Array.isArray(rule.enum) && !rule.enum.includes(actual)) errors.push(`${key}: value is not in enum`);
    if (typeof actual === "string" && typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(actual)) {
      errors.push(`${key}: does not match pattern`);
    }
    if (typeof actual === "string" && typeof rule.minLength === "number" && actual.length < rule.minLength) {
      errors.push(`${key}: shorter than minLength`);
    }
    if (typeof actual === "number" && typeof rule.minimum === "number" && actual < rule.minimum) {
      errors.push(`${key}: below minimum`);
    }
    if (rule.format === "date-time" && (typeof actual !== "string" || Number.isNaN(Date.parse(actual)))) {
      errors.push(`${key}: must be date-time`);
    }
  }
  return errors.length === 0 ? { ok:true } : { ok:false, errors };
}
