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

/** Only files the helper is allowed to touch: living memory, not code, not LESSONS.md, not docs/ or decision drafts. */
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
    "Project-life maintainer: update this project's living memory (progress, changelog, plans, todos) after accepted Lane Pilot work. Do not touch application code.",
    `Workspace: ${input.workspace}`,
    `Lane Pilot run: ${input.runId}`,
    `Run artifact dirs (writer reports for the accepted tasks): ${input.artifactDirs.join(", ") || "none"}`,
    `Current UTC time: ${input.nowIso}`,
    "Planning notes live in .agents/plans/ and .agents/todos/; read the ones that mention this Lane Pilot run id or the task ids below. Read ~/.agents/skills/project-life/SKILL.md and its references/memory.md, plans.md and todos.md first.",
    [
      "Then, in this order:",
      "1. .agents/PROGRESS.md (create it if missing): at most 40 lines, sections Now/Blocked/Next/Last verify/Pointers. It is a snapshot of the whole project, not of this run. Now lists 3-5 bullets of what the product can do today, by capability (read the code and README for it), not a list of recent tasks; documentation-only work is one short bullet at most.",
      "   Start from the current file and keep every line that is still true; change only what this work changed, and drop a line only when it is closed or no longer true. Pointers is rebuilt from the files every time: open todos from .agents/todos/INDEX.md (id and title), active plans from .agents/plans/, and .agents/CHANGELOG.md. Keep the <!-- auto:session-ledger --> block untouched.",
      `2. Append exactly one line to .agents/CHANGELOG.md (create it with a "# Changelog" heading if missing; never edit older lines): - ${input.nowIso.slice(0, 10)} ${input.runId}: <what changed, one sentence> (<task ids>; commit: see git log)`,
      "3. Tick the matching tasks in .agents/plans/items/*/PLAN.md and refresh .agents/plans/ROADMAP.md, only if those already exist.",
      "4. Add this run id to related_runs of an .agents/todos meta.yaml item only when this work clearly implements it, and refresh .agents/todos/INDEX.md statuses.",
    ].join("\n"),
    "Write everything in English. You may write only .agents/PROGRESS.md, .agents/CHANGELOG.md, .agents/plans/** and .agents/todos/**: Lane Pilot rejects the run on any other changed path. That leaves out application code, LESSONS.md, decision drafts in .agents/decisions/ (they stay with the PM), anything under .agents/runs/, and anything under docs/ (Lane Pilot writes the code documentation).",
    `When done, git add only the paths you changed under those allowed locations and, if anything changed, commit with message: chore(progress): update project memory after ${input.runId}`,
    "Accepted tasks:",
    JSON.stringify(input.tasks),
    'Finish with exactly one JSON line as your final message, and nothing after it: {"status":"updated"|"no_change","commit":"<full 40-char sha from git rev-parse HEAD, or null>","files":[...]}',
  ].join("\n\n");
}
