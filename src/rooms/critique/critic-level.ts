import { createHash } from "node:crypto";
import { DATA_PATH, MONEY_PATH } from "../tasks";

/**
 * How hard the code critic looks at a finished attempt, decided by rule from the task and its evidence (no model call). It replaced the
 * Jev screen `critique.screen`, which settled 13 of 401 runs and was wrong on 2 of the 6 labelled ones.
 *
 * - `strict`: the critic runs in gate mode (its rework stops acceptance). A change to a sensitive path (auth, secrets, money, migrations,
 *   permissions, deploy), risk high or critical, a task that also changes files outside its section in the same repository (`repo_scope`), a writer that edited a test which existed before the task, or no check at all on a change that is more than docs and tests.
 * - `skip`: no critic, the receipt names why. When a check failed (`check_failed`: the attempt goes back to the writer, so a critic would
 *   only repeat the failure; this holds for a pinned task too, but not over a strict reason above), or when every check passed and the
 *   change is docs, tests or lock files only, a chore, refactor or docs task of up to 8 files, or a non-feature change of up to 3 files.
 * - `normal`: everything else, as the project's settings say.
 *
 * On 401 critic runs of the hub (60 days to 2026-11-13) the skip rules would have cut 29% of the runs and lost 1 of the 18 that changed
 * the outcome. One skip in ten still goes to the critic (`skip_sampled`), so a finding the rule loses shows up in the receipts.
 * A task with quality_mode full, or a project that turned the critic on itself, never skips for size or kind; that is how the PM raises the level.
 */
export type CriticLevel = { tier: "strict" | "normal" | "skip"; reason: string };

// Money, migrations and schema come from the shared classifier (tasks/sensitive.ts, also the owner's three classes); the rest is the critic's own.
const SENSITIVE_OTHER = /(^|[/._-])(auth|oauth|login|secret|secrets|password|credential|credentials|crypto|permission|permissions|acl|rbac|deploy|deployment|dockerfile|docker-compose|ecosystem\.config|nginx|angie|systemd)([/._-]|$)|(^|\/)\.github\/workflows\/|(^|\/)infra\//i;
const isSensitivePath = (path: string): boolean => SENSITIVE_OTHER.test(path) || MONEY_PATH.test(path) || DATA_PATH.test(path);
const DOCS_OR_TESTS = /\.(md|mdx|rst)$|(^|\/)docs\/|(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$/i;
const SMALL_KINDS = new Set(["chore", "refactor", "docs"]);

/** The files a task's paths were widened by, kept per task so the code critic reads them at the end (question-rules.ts writes them). */
export const pathsWidenedKey = (runId: string, taskId: string) => `lp.paths-widened:${runId}:${taskId}`;
type WidenedKv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
export async function pathsWidenedOf(kv: WidenedKv, runId: string, taskId: string): Promise<string[]> {
  const value = await kv.get(pathsWidenedKey(runId, taskId)).catch(() => null);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
export async function markPathsWidened(kv: WidenedKv, runId: string, taskId: string, files: readonly string[]): Promise<void> {
  const known = await pathsWidenedOf(kv, runId, taskId);
  await kv.set(pathsWidenedKey(runId, taskId), [...new Set([...known, ...files])] as never);
}

/** One skip in ten by the task id: the same task always lands the same way, so a retry does not flip the decision. */
export const sampledSkip = (taskId: string): boolean => createHash("sha256").update(taskId).digest()[0]! < 26;

export function criticLevel(input: {
  taskId: string;
  kind?: string | null;
  risk?: string | null;
  paths: readonly string[];
  checks: readonly { exitCode: number }[];
  referenceTestEdits?: readonly string[];
  /** The task of a section chat that also changes files outside the section (repo_scope): a shared SDK breaks the other bots, so the critic gates it. */
  repoScope?: boolean;
  /** Files Lane Pilot added to this task's owns_paths on its writer's question (question-rules.ts): such a task is always looked at hard. */
  pathsWidened?: readonly string[];
  /** quality_mode full, or `code_critique.enabled` set by the project: the critic is never skipped. */
  pinned?: boolean;
}): CriticLevel {
  if (input.referenceTestEdits?.length) return { tier: "strict", reason: "reference_tests_edited" };
  if (input.repoScope) return { tier: "strict", reason: "repo_scope" };
  if (input.pathsWidened?.length) return { tier: "strict", reason: "paths_widened" };
  if (input.risk === "high" || input.risk === "critical") return { tier: "strict", reason: `risk_${input.risk}` };
  const sensitive = input.paths.find(isSensitivePath);
  if (sensitive) return { tier: "strict", reason: `sensitive_path:${sensitive}` };
  const docsOnly = input.paths.length > 0 && input.paths.every((path) => DOCS_OR_TESTS.test(path));
  if (input.checks.length === 0 && !docsOnly) return { tier: "strict", reason: "no_checks" };
  // A red check sends the attempt back to the writer whatever else holds, pinned or not: a critic would repeat what the check already says
  // (hub, 30 days to 2026-11-14: 2 of the 7 code-critic stops only repeated failing tests).
  if (input.checks.some((check) => check.exitCode !== 0)) return { tier: "skip", reason: "check_failed" };
  if (input.pinned) return { tier: "normal", reason: "pinned" };
  const skip = docsOnly ? "docs_tests_only"
    : SMALL_KINDS.has(input.kind ?? "") && input.paths.length <= 8 ? `small_${input.kind}`
    : input.kind !== "feature" && input.paths.length <= 3 ? "small_change"
    : null;
  if (!skip) return { tier: "normal", reason: "default" };
  return sampledSkip(input.taskId) ? { tier: "normal", reason: `skip_sampled:${skip}` } : { tier: "skip", reason: skip };
}

/** The plan critic's tier: the strong one for high and critical risk, quality_mode full and a task that also changes files outside its section (`repo_scope`). */
export function planCriticTier(task: { risk: string; repo_scope?: boolean }, qualityMode: string): { tier: "strong" | "light"; reason: string | null } {
  if (task.repo_scope === true) return { tier: "strong", reason: "repo_scope" };
  if (task.risk === "high" || task.risk === "critical") return { tier: "strong", reason: `risk_${task.risk}` };
  return qualityMode === "full" ? { tier: "strong", reason: "quality_full" } : { tier: "light", reason: null };
}
