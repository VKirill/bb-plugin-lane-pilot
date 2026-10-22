import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pluginRootFromModule } from "@lane-pilot/kit";
import { TASK_V2_OPTIONAL, taskV2Schema, type TaskV2 } from "../contracts";
import { applyTrustedTooling } from "./trusted-tooling";

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
  const extras = Object.keys(record).filter((key) => !(TASK_V2_REQUIRED as readonly string[]).includes(key) && !(TASK_V2_OPTIONAL as readonly string[]).includes(key));
  if (extras.length > 0) return { ok:false, errors:extras.map((key) => `${key}: additionalProperties is false`) };
  // A relative cwd is read against project_cwd; from here on every check carries an absolute folder.
  const task = { ...parsed.data, verification:parsed.data.verification.map((check) => (isAbsolute(check.cwd) ? check : { ...check, cwd:resolve(parsed.data.project_cwd, check.cwd) })) };
  // Trusted tooling (hooks, CI, .claude, the task's own check scripts) joins never_touch unless owns_paths names it (P2-4).
  return { ok:true, task:applyTrustedTooling(task) };
}
