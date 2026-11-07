import { isCodeCriticDefault } from "../contracts";
import type { CodeCriticDefault } from "../contracts";
import { ownsPathsOverlap } from "@lane-pilot/kit";

/**
 * quality_mode decides which review stages a task goes through. It is a project setting and an optional field of the task
 * contract (the task's wins), and nothing has to be set: no value is `standard`, which is the behaviour before the mode existed.
 * - quick: no plan critique and no code critique.
 * - standard: as the project's own settings say (plan critique by its risk policy, code critique only when enabled).
 * - full: plan critique on every task, code critique on every task, and a browser check for a task that carries qa_cases.
 */
export const QUALITY_MODES = ["quick", "standard", "full"] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];
export const DEFAULT_QUALITY_MODE: QualityMode = "standard";
export const QUALITY_MODE_SETTING = "quality_mode";

const isMode = (value: unknown): value is QualityMode => (QUALITY_MODES as readonly unknown[]).includes(value);

/** The task's own mode, else the project setting, else standard; an unknown value reads as standard. */
export function resolveQualityMode(task: { quality_mode?: unknown } | null | undefined, projectValue: unknown): QualityMode {
  if (isMode(task?.quality_mode)) return task.quality_mode;
  return isMode(projectValue) ? projectValue : DEFAULT_QUALITY_MODE;
}

/** The project settings as the stages of this mode must read them; standard returns them as they are. */
export function applyQualityMode(settings: Record<string, unknown>, mode: QualityMode): Record<string, unknown> {
  if (mode === "quick") return { ...settings, "plan_critique.enabled": false, "code_critique.enabled": false };
  if (mode === "full") return { ...settings, "plan_critique.enabled": true, "plan_critique.min_score": 0, "code_critique.enabled": true };
  return settings;
}

/** A task of a full-mode project that carries qa_cases is not done until its browser check has passed. */
export const browserQaRequired = (mode: QualityMode, task: { qa_cases?: readonly string[] } | null | undefined): boolean =>
  mode === "full" && (task?.qa_cases?.length ?? 0) > 0;

export type TaskQaPlan = { url: string; cases: string[]; envClass: "local" | "staging" | "preview" | "production" | "unknown"; devServer: string };

/** What the task's graph runs as its browser check: the task has both qa_cases and qa_url (the mode does not matter); null when it has not. */
export function taskQaPlan(task: { qa_cases?: readonly string[]; qa_url?: string; qa_env_class?: TaskQaPlan["envClass"]; qa_dev_server?: string } | null | undefined): TaskQaPlan | null {
  if (!task?.qa_url || (task.qa_cases?.length ?? 0) === 0) return null;
  let loopback = false;
  try { loopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(task.qa_url).hostname); } catch { /* the schema refuses an address that is not http(s) */ }
  return { url: task.qa_url, cases: [...task.qa_cases!], envClass: task.qa_env_class ?? (loopback ? "local" : "unknown"), devServer: task.qa_dev_server ?? "" };
}

/**
 * The code critic by the task's risk (SMA plan P1-3). `critic.code.default_for_risk` is `off` (the critic runs only when
 * `code_critique.enabled` or quality_mode full says so), `medium` (it also runs for risk medium, high and critical) or `high` (high and
 * critical). Unset is `medium`, and the critic then runs as advisory: notes go back to the writer, a high or critical rubric fail still blocks. The bench passes its arm's value with the dispatch
 * (`criticCodeDefault`), which wins over the project setting. A project that set `code_critique.enabled` itself, either way, keeps its choice,
 * and quality_mode quick or full decide before this does.
 */
export const CODE_CRITIC_DEFAULT_SETTING = "critic.code.default_for_risk";
export { CODE_CRITIC_DEFAULTS } from "../contracts";
export type { CodeCriticDefault } from "../contracts";
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };


/** The dispatch's override, else the project's value, else medium. An unknown value reads as medium. The model is the code-critic role row. */
export function resolveCodeCriticDefault(projectValue: unknown, override?: unknown): CodeCriticDefault {
  if (isCodeCriticDefault(override)) return override;
  return isCodeCriticDefault(projectValue) ? projectValue : "medium";
}

/** The settings the code critic must read for a task of this risk: standard mode plus a risk default turns `code_critique.enabled` on. */
export function applyCodeCriticDefault(settings: Record<string, unknown>, mode: QualityMode, risk: string | undefined, level: CodeCriticDefault): Record<string, unknown> {
  const unset = settings["code_critique.enabled"] === undefined || settings["code_critique.enabled"] === null || settings["code_critique.enabled"] === "";
  if (mode !== "standard" || level === "off" || !unset) return settings;
  const needed = level === "medium" ? RISK_RANK.medium! : RISK_RANK.high!;
  if ((RISK_RANK[risk ?? ""] ?? 0) < needed) return settings;
  const modeUnset = settings["code_critique.mode"] == null || settings["code_critique.mode"] === "";
  return { ...settings, "code_critique.enabled": true, ...(modeUnset ? { "code_critique.mode": "advisory" } : {}) };
}

/**
 * A writer that changed a test which existed before the task changed the yardstick: the code critic reviews it whatever the risk or
 * quality mode, and its rework stops acceptance (gate). On the hub 134 of 756 tasks did so, and the critic saw none of them (2026-10-31).
 */
export function withReferenceTestCritic(settings: Record<string, unknown>, referenceTestEdits: readonly string[] | undefined): Record<string, unknown> {
  return referenceTestEdits?.length ? { ...settings, "code_critique.enabled": true, "code_critique.mode": "gate" } : settings;
}

/**
 * The code critic does not re-review the same files for a small change (hub, 30 days: 221 of 294 runs looked at files a
 * critic approved < 48 h earlier and 4 found anything above info). 40 changed lines is the «мелкая правка» bound.
 */
export const CRITIQUE_REPEAT_MAX_LINES = 40;
export const CRITIQUE_REPEAT_WINDOW_MS = 48 * 3_600_000;

export type CritiqueRepeatApproval = {
  taskId: string;
  ownsPaths: readonly string[];
  state: string;
  decision: unknown;
  updatedAt: number;
};

/** Added+removed lines across the candidate's unified patches; the +++/--- file headers do not count. */
export function patchChangedLines(patches: Record<string, string> | null | undefined): number {
  let lines = 0;
  for (const patch of Object.values(patches ?? {})) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+") || line.startsWith("-")) lines += 1;
    }
  }
  return lines;
}

/**
 * Whether this task's code critique is a repeat of one already approved in this run: skips only a low or medium risk
 * task (never high or critical), with no reference-test edits (the withReferenceTestCritic case never skips), a diff of
 * at most CRITIQUE_REPEAT_MAX_LINES changed lines (`null` — the diff could not be measured — never skips), and a prior
 * code-critique receipt of another task, state passed with decision approve, less than CRITIQUE_REPEAT_WINDOW_MS old,
 * whose owns_paths overlap this task's. Returns the prior task id for the `repeat:` receipt reason.
 */
export function critiqueRepeatSkip(input: {
  risk: string | undefined;
  referenceTestEdits: readonly string[] | undefined;
  changedLines: number | null;
  ownsPaths: readonly string[];
  priorApprovals: readonly CritiqueRepeatApproval[];
  now?: number;
}): { reason: "repeat"; priorTaskId: string } | null {
  const rank = RISK_RANK[input.risk ?? ""];
  if (rank === undefined || rank > RISK_RANK.medium!) return null;
  if (input.referenceTestEdits?.length) return null;
  if (input.changedLines === null || input.changedLines > CRITIQUE_REPEAT_MAX_LINES) return null;
  const now = input.now ?? Date.now();
  const prior = input.priorApprovals.find((row) =>
    row.state === "passed" && row.decision === "approve"
    && now - row.updatedAt >= 0 && now - row.updatedAt < CRITIQUE_REPEAT_WINDOW_MS
    && ownsPathsOverlap([...row.ownsPaths], [...input.ownsPaths]));
  return prior ? { reason: "repeat", priorTaskId: prior.taskId } : null;
}
