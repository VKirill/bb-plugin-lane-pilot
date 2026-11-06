import { TRUSTED_TOOLING_PATTERNS, verificationScriptPaths } from "../tasks";
import { renderBrief } from "../brief";

/**
 * The contract fields a review stage can ask for, beyond the code critic's base set
 * (title, objective, acceptance, invariants, out_of_scope, owns_paths, never_touch).
 * A stage lists only what its method judges; unknown keys of the task are never printed.
 */
export type TaskBriefField =
  | "title" | "objective" | "risk" | "acceptance" | "invariants" | "out_of_scope"
  | "read_first" | "interfaces" | "expected_outputs" | "owns_paths" | "never_touch"
  | "depends_on" | "test_removals" | "verification";

const BASE_FIELDS: readonly TaskBriefField[] = [
  "title", "objective", "acceptance", "invariants", "out_of_scope", "owns_paths", "never_touch",
];

/** Print order, not the option's order: a person reads the same layout in every stage's prompt. */
const FIELD_ORDER: readonly TaskBriefField[] = [
  "title", "objective", "risk", "acceptance", "invariants", "out_of_scope",
  "read_first", "interfaces", "expected_outputs", "owns_paths", "never_touch",
  "depends_on", "test_removals", "verification",
];

/**
 * The task contract for a person to read, not the JSON the contract is stored as: the fields a review judges against.
 * `fields` replaces the base set; a field the task does not carry is not printed.
 * never_touch appears only with entries beyond the standard trusted tooling every task already gets (hooks, CI, .claude,
 * check scripts — src/rooms/tasks/trusted-tooling.ts). verification prints command and cwd only: a check's `secrets`
 * names and `hidden` flag stay out of the prompt.
 */
export function taskBrief(task: unknown, options?: { fields?: readonly TaskBriefField[] }): string {
  if (!task || typeof task !== "object") return JSON.stringify(task);
  const row = task as Record<string, unknown>;
  const include = new Set(options?.fields ?? BASE_FIELDS);
  const strings = (key: string) => Array.isArray(row[key]) ? (row[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const bodies: Record<string, string[]> = { goal: [], inputs: [], boundaries: [], acceptance: [] };
  const push = (label: string, items: string[]) => { if (items.length) bodies[sectionOf(label)]!.push(`${label}:`, ...items.map((item) => `- ${item}`)); };
  for (const field of FIELD_ORDER) {
    if (!include.has(field)) continue;
    if (field === "title" || field === "objective" || field === "risk") {
      if (typeof row[field] === "string" && row[field]) bodies.goal!.push(`${field}: ${row[field]}`);
      continue;
    }
    if (field === "owns_paths") {
      const owns = strings("owns_paths");
      if (owns.length) bodies.boundaries!.push(`owns_paths: ${owns.join(", ")}`);
      continue;
    }
    if (field === "never_touch") {
      const standard = new Set([
        ...TRUSTED_TOOLING_PATTERNS,
        ...verificationScriptPaths({ project_cwd: String(row.project_cwd ?? ""), verification: Array.isArray(row.verification) ? row.verification as Array<{ command: string; cwd: string }> : [] }),
      ]);
      const extra = strings("never_touch").filter((pattern) => !standard.has(pattern));
      if (extra.length) bodies.boundaries!.push(`never_touch (on top of the standard trusted tooling): ${extra.join(", ")}`);
      continue;
    }
    if (field === "verification") {
      const checks = Array.isArray(row.verification) ? row.verification : [];
      const items = checks.filter((check): check is { command: string; cwd?: unknown } =>
        !!check && typeof check === "object" && typeof (check as { command?: unknown }).command === "string")
        .map((check) => typeof check.cwd === "string" && check.cwd ? `${check.command}  (cwd: ${check.cwd})` : check.command);
      push("verification", items);
      continue;
    }
    push(field, strings(field));
  }
  const rendered = renderBrief({
    role: "critic",
    ...(bodies.goal!.length ? { goal: bodies.goal!.join("\n") } : {}),
    ...(bodies.inputs!.length ? { inputs: bodies.inputs!.join("\n") } : {}),
    ...(bodies.boundaries!.length ? { boundaries: bodies.boundaries!.join("\n") } : {}),
    ...(bodies.acceptance!.length ? { acceptance: bodies.acceptance!.join("\n") } : {}),
  });
  return rendered.text || JSON.stringify(task);
}

/** Which tagged section a contract field lands in (title/objective/risk → task_goal, the rest by their kind). */
function sectionOf(field: string): "goal" | "inputs" | "boundaries" | "acceptance" {
  if (field === "read_first" || field === "interfaces" || field === "expected_outputs") return "inputs";
  if (field === "acceptance" || field === "verification") return "acceptance";
  return "boundaries";
}
