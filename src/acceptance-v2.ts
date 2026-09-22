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
  if (record.schema_version !== 2) errors.push("schema_version: must be 2");
  if (record.accepted !== true) errors.push("accepted: must be true");
  if (record.provider_exit !== 0) errors.push("provider_exit: must be 0");
  if (record.report !== "complete") errors.push("report: must be complete");
  if (record.owns_check !== "passed") errors.push("owns_check: must be passed");
  if (record.verification !== "passed") errors.push("verification: must be passed");
  if (record.review !== "passed" && record.review !== "not_required") errors.push("review: must be passed or not_required");
  if (typeof record.task_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.task_sha256)) {
    errors.push("task_sha256: must be 64 hex chars");
  }
  if (typeof record.report_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.report_sha256)) {
    errors.push("report_sha256: must be 64 hex chars");
  }
  if (typeof record.accepted_at !== "string" || Number.isNaN(Date.parse(record.accepted_at))) {
    errors.push("accepted_at: must be date-time");
  }
  return errors.length === 0 ? { ok:true } : { ok:false, errors };
}
