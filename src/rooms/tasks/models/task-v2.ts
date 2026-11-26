import { isAbsolutePath, resolvePath } from "./path-utils";
import { isReservedRepoSelector, TASK_V2_OPTIONAL, taskV2Schema, type TaskV2 } from "../../contracts";
import { applyTrustedTooling } from "./trusted-tooling";
import { isOutputPath } from "./validate-output";

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

/** Optional upstream task-v2 fields a BB writer does not use; accepted and dropped. */
const UPSTREAM_OPTIONAL = ["context_selectors", "impact_receipt"] as const;

function reservedRepoPathFindings(task:TaskV2):string[] {
  const findings:string[] = [];
  const pathFields:Array<[string, readonly string[]]> = [
    ["owns_paths", task.owns_paths],
    ["expected_outputs", task.expected_outputs],
    ["never_touch", task.never_touch],
    ...(task.test_removals ? [["test_removals", task.test_removals] as [string, readonly string[]]] : []),
    ...(task.drawing ? [["drawing", task.drawing] as [string, readonly string[]]] : []),
  ];
  for (const [field, paths] of pathFields) for (const path of paths) {
    if (field !== "expected_outputs" || isOutputPath(path)) {
      if (isReservedRepoSelector(path)) findings.push(`${field} uses reserved repo: selector: ${path}; repo: is read-only; write paths/check cwd use project_cwd coordinates`);
    }
  }
  for (const [index, file] of (task.files ?? []).entries()) {
    if (isReservedRepoSelector(file.path)) findings.push(`files[${index}].path uses reserved repo: selector: ${file.path}; repo: is read-only; write paths/check cwd use project_cwd coordinates`);
  }
  for (const [index, check] of task.verification.entries()) {
    if (isReservedRepoSelector(check.cwd)) findings.push(`verification[${index}].cwd uses reserved repo: selector: ${check.cwd}; repo: is read-only; write paths/check cwd use project_cwd coordinates`);
  }
  return findings;
}

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
  const reservedRepoPaths = reservedRepoPathFindings(parsed.data);
  if (reservedRepoPaths.length) return { ok:false, errors:reservedRepoPaths };
  // A relative cwd is read against project_cwd; from here on every check carries an absolute folder.
  const task = { ...parsed.data, verification:parsed.data.verification.map((check) => (isAbsolutePath(check.cwd) ? check : { ...check, cwd:resolvePath(parsed.data.project_cwd, check.cwd) })) };
  // Trusted tooling (hooks, CI, .claude, the task's own check scripts) joins never_touch unless owns_paths names it (P2-4).
  return { ok:true, task:applyTrustedTooling(task) };
}
