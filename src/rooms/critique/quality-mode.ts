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
 * critical). The default stays `off` until the bench has measured the critic on and off. The bench passes its arm's value with the dispatch
 * (`criticCodeDefault`), which wins over the project setting. A project that set `code_critique.enabled` itself, either way, keeps its choice,
 * and quality_mode quick or full decide before this does.
 */
export const CODE_CRITIC_DEFAULT_SETTING = "critic.code.default_for_risk";
export const CODE_CRITIC_DEFAULTS = ["off", "medium", "high"] as const;
export type CodeCriticDefault = (typeof CODE_CRITIC_DEFAULTS)[number];
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const isCodeCriticDefault = (value: unknown): value is CodeCriticDefault => (CODE_CRITIC_DEFAULTS as readonly unknown[]).includes(value);

/** The dispatch's override, else the project's value, else off; an unknown value reads as off. */
export function resolveCodeCriticDefault(projectValue: unknown, override?: unknown): CodeCriticDefault {
  if (isCodeCriticDefault(override)) return override;
  return isCodeCriticDefault(projectValue) ? projectValue : "off";
}

/** The settings the code critic must read for a task of this risk: standard mode plus a risk default turns `code_critique.enabled` on. */
export function applyCodeCriticDefault(settings: Record<string, unknown>, mode: QualityMode, risk: string | undefined, level: CodeCriticDefault): Record<string, unknown> {
  const unset = settings["code_critique.enabled"] === undefined || settings["code_critique.enabled"] === null || settings["code_critique.enabled"] === "";
  if (mode !== "standard" || level === "off" || !unset) return settings;
  const needed = level === "medium" ? RISK_RANK.medium! : RISK_RANK.high!;
  return (RISK_RANK[risk ?? ""] ?? 0) >= needed ? { ...settings, "code_critique.enabled": true } : settings;
}
