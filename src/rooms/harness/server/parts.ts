import { LANE_PILOT_SURFACE, alwaysOnText, checkNames, missionPointer, skillNames, type Tree } from "@lane-pilot/harness-core";
import type { RuleForm } from "@lane-pilot/run-insights";
import { checkBrief, renderBrief } from "../../brief";
import type { HarnessRow } from "./store";

export const HARNESS_DIR = ".lane-pilot/harness";

/** Every helper mission of the harness graphs renders through the shared brief (evidence lives on disk under context/, so the brief is instructions only). */
export function harnessMission(job: string, layout: string): string {
  const brief = renderBrief({ role: "harness-editor", instructions: [missionPointer(job, layout)] });
  checkBrief("harness-editor", brief.text, { instructionsLength: brief.instructionsLength });
  return brief.text;
}

export type BriefParts = { harnessId: string; arm: "new" | "old" | null; alwaysOn: string; memory: string; skillNames: string[]; checkNames: string[]; tree: Tree };

export const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project";

export function briefParts(row: Pick<HarnessRow, "id" | "tree">, arm: "new" | "old" | null): BriefParts {
  const tree = row.tree;
  const memory = (tree[LANE_PILOT_SURFACE.memoryFile] ?? "").split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).map((line) => line.trim()).join("\n");
  return { harnessId: row.id, arm, alwaysOn: alwaysOnText(tree).trim(), memory, skillNames: skillNames(tree), checkNames: checkNames(tree), tree };
}

/** Verification commands a tree adds to an attempt: its checks, run from the worktree where they were materialized. */
export function checkCommands(tree: Tree): Array<{ command: string; timeout_sec: number }> {
  return checkNames(tree).map((rel) => {
    const runner = rel.endsWith(".py") ? "python3" : rel.endsWith(".mjs") ? "node" : "bash";
    return { command: `${runner} ${HARNESS_DIR}/${rel}`, timeout_sec: 60 };
  });
}

/** The lesson's form from the component it names; the rules UI and the writer brief route on it. */
/** The settings file a Claude Code writer reads its hooks from: the tree's hooks.json as written, under the one `hooks` key. */
export function hooksSettings(hooksJson: string): string {
  try {
    const parsed = JSON.parse(hooksJson) as { hooks?: unknown };
    return JSON.stringify({ hooks: parsed.hooks ?? {} }, null, 2);
  } catch { return JSON.stringify({ hooks: {} }); }
}

export function inferForm(lesson: string): RuleForm {
  const text = lesson.toLowerCase();
  if (/\bchecks?\b|verification|\.sh\b|\.py\b|\.mjs\b/.test(text)) return "check";
  if (/\bskill\b/.test(text)) return "skill";
  if (/\bhooks?\b/.test(text)) return "hook";
  if (/\bmemory\b|memory\.md|\bnote\b/.test(text)) return "memory";
  return "always";
}
