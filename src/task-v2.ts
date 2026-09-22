import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { taskV2Schema, type TaskV2 } from "./contracts";

export const TASK_V2_REQUIRED = [
  "schema_version",
  "id",
  "title",
  "risk",
  "lane",
  "project_cwd",
  "read_first",
  "interfaces",
  "invariants",
  "out_of_scope",
  "expected_outputs",
  "owns_paths",
  "never_touch",
  "depends_on",
  "objective",
  "acceptance",
  "verify",
  "verification",
] as const;

export function loadTaskV2Schema(): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "../lane-stack/schemas/task-v2.schema.json");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function validateTaskV2(value: unknown): { ok:true; task:TaskV2 } | { ok:false; errors:string[] } {
  const parsed = taskV2Schema.safeParse(value);
  if (!parsed.success) {
    return { ok:false, errors:parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
  }
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter((key) => !(TASK_V2_REQUIRED as readonly string[]).includes(key) && key !== "skills");
  if (extras.length > 0) return { ok:false, errors:extras.map((key) => `${key}: additionalProperties is false`) };
  return { ok:true, task:parsed.data };
}
