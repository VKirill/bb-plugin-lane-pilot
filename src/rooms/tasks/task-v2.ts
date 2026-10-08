import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRootFromModule } from "@lane-pilot/kit";
import { taskV2Schema, type TaskV2 } from "../contracts";

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
  const path = join(pluginRootFromModule(import.meta.url), "lane-stack/schemas/task-v2.schema.json");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Optional upstream task-v2 fields a BB writer does not use; accepted and dropped. */
const UPSTREAM_OPTIONAL = ["context_selectors", "impact_receipt"] as const;

export function validateTaskV2(value: unknown): { ok:true; task:TaskV2 } | { ok:false; errors:string[] } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    value = Object.fromEntries(Object.entries(value).filter(([key]) => !(UPSTREAM_OPTIONAL as readonly string[]).includes(key)));
  }
  const parsed = taskV2Schema.safeParse(value);
  if (!parsed.success) {
    return { ok:false, errors:parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
  }
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter((key) => !(TASK_V2_REQUIRED as readonly string[]).includes(key) && key !== "skills" && key !== "area" && key !== "quality_mode" && key !== "qa_cases" && key !== "convergence" && key !== "files");
  if (extras.length > 0) return { ok:false, errors:extras.map((key) => `${key}: additionalProperties is false`) };
  return { ok:true, task:parsed.data };
}
