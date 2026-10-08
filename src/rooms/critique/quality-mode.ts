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
