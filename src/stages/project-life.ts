export type ProjectLifeSettings = { enabled: boolean };

export const PROJECT_LIFE_DEFAULT_WRITER = { providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "fast" } as const;

/** The stage's own pick, else the default; the project writer is never inherited (it may be an interactive CLI). */
export function projectLifeWriterSelection(settings: Record<string, unknown>): { providerId: string; model: string } {
  const provider = settings["project_life.provider"], model = settings["project_life.model"];
  return typeof provider === "string" && provider && typeof model === "string" && model
    ? { providerId: provider, model }
    : { providerId: PROJECT_LIFE_DEFAULT_WRITER.providerId, model: PROJECT_LIFE_DEFAULT_WRITER.model };
}

const ALLOWED_EXACT_PATHS = new Set([".agents/PROGRESS.md", ".agents/CHANGELOG.md"]);
const ALLOWED_PATH_PREFIXES = [".agents/plans/", ".agents/todos/"];

export type ProjectLifeTaskSummary = { id: string; title: string; objective: string; acceptanceSummary: string };

export type ProjectLifeFinalMessage = { status: "updated" | "no_change"; commit: string | null; files: string[] };

function parseBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "on" || value === "yes") return true;
  if (value === 0 || value === "0" || value === "false" || value === "off" || value === "no") return false;
  throw new Error(`${name} must be a boolean`);
}

export function parseProjectLifeSettings(raw: Record<string, unknown>): ProjectLifeSettings {
  return { enabled: parseBoolean(raw["project_life.enabled"], true, "project_life.enabled") };
}

/** Only files the helper is allowed to touch: living memory, not code, not LESSONS.md, not docs/decisions.md. */
export function isAllowedProjectLifePath(path: string): boolean {
  const clean = path.replace(/^\.\//, "");
  return ALLOWED_EXACT_PATHS.has(clean) || ALLOWED_PATH_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

export function findOutOfScopeProjectLifeWrites(paths: string[]): string[] {
  return paths.filter((path) => !isAllowedProjectLifePath(path));
}

/** The wave is idle only once nothing else is still open for this run; a busy run defers to a later trigger. */
export function shouldTriggerProjectLife(openAttemptRunIds: string[], runId: string): boolean {
  return !openAttemptRunIds.includes(runId);
}

/** Tasks accepted in parallel fold into one update: only tasks not yet covered by an earlier passed receipt. */
export function foldCoveredTaskIds(acceptedTaskIds: string[], alreadyCoveredTaskIds: string[]): string[] {
  const covered = new Set(alreadyCoveredTaskIds);
  return [...new Set(acceptedTaskIds)].filter((id) => !covered.has(id)).sort();
}

export function parseProjectLifeFinalMessage(output: string): ProjectLifeFinalMessage {
  const lines = output.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error("project_life_output_empty");
  let decoded: unknown;
  try { decoded = JSON.parse(last); } catch { throw new Error("project_life_final_message_not_json"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("project_life_final_message_invalid");
  const row = decoded as Record<string, unknown>;
  if (row.status !== "updated" && row.status !== "no_change") throw new Error("project_life_final_message_status_invalid");
  if (row.commit !== null && typeof row.commit !== "string") throw new Error("project_life_final_message_commit_invalid");
  if (!Array.isArray(row.files) || row.files.some((file) => typeof file !== "string")) throw new Error("project_life_final_message_files_invalid");
  return { status: row.status, commit: row.commit, files: row.files as string[] };
}

export function projectLifePrompt(input: {
  workspace: string;
  runId: string;
  artifactDirs: string[];
  tasks: ProjectLifeTaskSummary[];
  nowIso: string;
}): string {
  return [
    "Project-life maintainer: update this project's living memory after accepted Lane Pilot work. Do not touch application code.",
    `Workspace: ${input.workspace}`,
    `Lane Pilot run: ${input.runId}`,
    `Run artifact dirs (writer reports for the accepted tasks): ${input.artifactDirs.join(", ") || "none"}`,
    "The PM may keep PLAN.md/SPEC.md/STATUS.md/run.yaml for this work in a separate .agents/runs/<slug>/ directory. Find the planning run whose STATUS or PLAN references this Lane Pilot run id or the accepted task ids below.",
    `Current UTC time: ${input.nowIso}`,
    "Read the project-life skill and its references first, in this order: ~/.agents/skills/project-life/SKILL.md, then ~/.claude/plugins/marketplaces/claude-lane-stack/skills/project-life/SKILL.md. Load references/memory.md, references/plans.md and references/todos.md from whichever location exists.",
    "If the planning run's run.yaml has a non-empty finalize: block, apply it first the way ~/.agents/bin/run-finalize would (progress_now/close_next/close_open).",
    "Then update .agents/PROGRESS.md, creating it if missing: at most 40 lines, sections Now/Blocked/Next/Last verify. It is a snapshot of the whole project, not of this run: start from the current file, keep every line that is still true (other sections such as Pointers, open todos, blockers, Next items, earlier shipped facts), change only what this work changed, and drop a line only when it is closed or no longer true. Keep the <!-- auto:session-ledger --> block untouched.",
    `Then append exactly one line to .agents/CHANGELOG.md (create it with a "# Changelog" heading if missing; never edit older lines): - ${input.nowIso.slice(0, 10)} ${input.runId}: <what changed, one sentence> (<task ids>; commit: see git log)`,
    "Tick the matching tasks in .agents/plans/items/*/PLAN.md and refresh .agents/plans/ROADMAP.md, but only if those already exist.",
    "Add this run id to related_runs of any .agents/todos meta.yaml item that this work clearly implements, only on a clear match, and refresh .agents/todos/INDEX.md statuses.",
    "Write everything in English. You may write only .agents/PROGRESS.md, .agents/CHANGELOG.md, .agents/plans/** and .agents/todos/** — no application code, no LESSONS.md, no docs/decisions.md; those stay with the PM.",
    `When done, git add only the paths you changed under those allowed locations and, if anything changed, commit with message: chore(progress): update project memory after ${input.runId}`,
    "Accepted tasks:",
    JSON.stringify(input.tasks),
    'Finish with exactly one JSON line as your final message, and nothing after it: {"status":"updated"|"no_change","commit":"<full 40-char sha from git rev-parse HEAD, or null>","files":[...]}',
  ].join("\n\n");
}
