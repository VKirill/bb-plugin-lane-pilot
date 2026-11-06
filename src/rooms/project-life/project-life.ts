import { resolveRoleModel } from "@lane-pilot/models";
import { checkBrief, renderBrief } from "../brief";

export type ProjectLifeSettings = { enabled: boolean };

/** The fast tier is asked only of codex (its small models take it); `project_life.service_tier = standard` turns it off there too. */
export function projectLifeServiceTier(settings: Record<string, unknown>, providerId: string): "fast" | "standard" {
  return providerId === "codex" && settings["project_life.service_tier"] !== "standard" ? "fast" : "standard";
}

/**
 * The project-life row of the role table, from the settings alone (the stage asks the one resolver, resolveSpawnModel, which adds what the machine
 * offers): the stage's own `project_life.*` pick, else the table; the project writer is never inherited (it may be an interactive CLI).
 */
export function projectLifeWriterSelection(settings: Record<string, unknown>): { providerId: string; model: string } {
  const { providerId, model } = resolveRoleModel("project-life", settings);
  return { providerId, model };
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
  const brief = renderBrief({
    role: "project-life",
    instructions: [
      [
        "Then, in this order:",
        "1. .agents/PROGRESS.md (create it if missing): at most 40 lines, sections Now/Blocked/Next/Last verify/Pointers. It is a snapshot of the whole project, not of this run. Now lists 3-5 bullets of what the product can do today, by capability (read the code and README for it), not a list of recent tasks; documentation-only work is one short bullet at most.",
        "   Start from the current file and keep every line that is still true; change only what this work changed, and drop a line only when it is closed or no longer true. Pointers is rebuilt from the files every time: open todos from .agents/todos/INDEX.md (id and title), active plans from .agents/plans/, and .agents/CHANGELOG.md. Keep the <!-- auto:session-ledger --> block untouched.",
        `2. Append exactly one line to .agents/CHANGELOG.md (create it with a "# Changelog" heading if missing; never edit older lines): - ${input.nowIso.slice(0, 10)} ${input.runId}: <what changed, one sentence> (<task ids>; commit: see git log)`,
        "3. Tick the matching tasks in .agents/plans/items/*/PLAN.md and refresh .agents/plans/ROADMAP.md, only if those already exist.",
        "4. Add this run id to related_runs of an .agents/todos meta.yaml item only when this work clearly implements it, and refresh .agents/todos/INDEX.md statuses.",
      ].join("\n"),
    ],
    goal: "Project-life maintainer: update this project's living memory (progress, changelog, plans, todos) after accepted Lane Pilot work. Do not touch application code.",
    inputs: [
      `Workspace: ${input.workspace}`,
      `Lane Pilot run: ${input.runId}`,
      `Run artifact dirs (writer reports for the accepted tasks): ${input.artifactDirs.join(", ") || "none"}`,
      `Current UTC time: ${input.nowIso}`,
      "Planning notes live in .agents/plans/ and .agents/todos/; read the ones that mention this Lane Pilot run id or the task ids below. When the project-life skill is among your skills, its references/memory.md, plans.md and todos.md describe the formats.",
    ].join("\n"),
    boundaries: "Write everything in English. You may write only .agents/PROGRESS.md, .agents/CHANGELOG.md, .agents/plans/** and .agents/todos/**: Lane Pilot rejects the run on any other changed path. That leaves out application code, LESSONS.md, decision drafts in .agents/decisions/ (they stay with the PM), anything under .agents/runs/, and anything under docs/ (Lane Pilot writes the code documentation).",
    output: [
      `When done, git add only the paths you changed under those allowed locations and, if anything changed, commit with message: chore(progress): update project memory after ${input.runId}`,
      'Finish with exactly one JSON line as your final message, and nothing after it: {"status":"updated"|"no_change","commit":"<full 40-char sha from git rev-parse HEAD, or null>","files":[...]}',
    ].join("\n"),
    data: [{ tag: "accepted_tasks", title: "Accepted tasks", text: JSON.stringify(input.tasks) }],
    restate: "update the living memory after this Lane Pilot run and end with the JSON line",
  });
  checkBrief("project-life", brief.text, { instructionsLength: brief.instructionsLength });
  return brief.text;
}

/** One CHANGELOG line for the accepted tasks: titles, whitespace folded, capped; written by script, no model. */
export function changelogLine(input: { date: string; runId: string; tasks: ProjectLifeTaskSummary[] }): string {
  const what = input.tasks.map((task) => (task.title || task.objective || task.id).replace(/\s+/g, " ").trim()).join("; ").slice(0, 400);
  return `- ${input.date} ${input.runId}: ${what} (${input.tasks.map((task) => task.id).join(", ")})\n`;
}

/**
 * The shell that appends the line to .agents/CHANGELOG.md and commits only that file on the checked-out branch.
 * Prints the commit sha, or `none` when .agents is git-ignored (the line stays local). Hooks are skipped: a diary line.
 */
export function changelogCommand(line: string, runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("project_life_run_id_unsafe");
  const b64 = Buffer.from(line, "utf8").toString("base64");
  return [
    "set -e", "f=.agents/CHANGELOG.md", "mkdir -p .agents",
    `[ -f "$f" ] || printf '# Changelog\\n\\n' > "$f"`,
    `if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi`,
    `printf %s '${b64}' | base64 --decode >> "$f"`,
    `if git check-ignore -q "$f"; then echo none; exit 0; fi`,
    `git add -- "$f"`,
    `git commit -q --no-verify -m 'chore(progress): changelog after ${runId}' --only -- "$f"`,
    "git rev-parse HEAD",
  ].join("\n");
}
