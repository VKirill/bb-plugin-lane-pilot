import type { MemoryDatabase } from "@lane-pilot/memory-core";
import { applyMoveSection, planMoveSection, type MoveSectionOptions, type MoveSectionPlan } from "../services/move-section";

/**
 * `bb lane-pilot memory move-section`: everything Lane Pilot keeps for one BB section (a folder and, listed with it, its child folders) follows the
 * section into another project. Reorganising BB projects moves folders and threads in BB; this is the half BB does not know about.
 *
 * What moves (a row is found by the section in its scope, or by a link to a row that moves):
 *  - memory notes whose `scope_json` holds the section, every status (active, superseded, expired, archive), with vectors, chunk vectors, word indexes,
 *    promotions, held conflicts between two moved notes, receipts whose every returned note moved, and misses that name a moved note;
 *  - rules (`lane_pilot_rule_proposal`) scoped to the section, with their events and promotions;
 *  - learning items that point at a moved note or rule (or sit in a thread named by --thread-ids) and the observation each was drawn from;
 *  - the section's own settings (`binding_id = section:<id>`), the accepted-task facts the wave summaries read for runs of the section.
 * What stays (counted, for a person to look at): notes of ancestor sections and of the project root (and how many of the root's mention the section's
 * name, a hint only), the section's runs and their history (bound to BB threads and workspaces), the owner's anamnesis (it has no project),
 * misses that name no note, conflicts with one side moved, settings that would collide with the target's.
 *
 * The scope of a moved note drops the sections above the moved one (they stay in the source project): by default [section, ...children] as stored
 * (the folder ids survive the BB move), `--to-section T` renames the section to T, `--root` puts the section's notes at the target's root
 * (`project:root`, or the children's chain when the note sat in a child).
 *
 * Duplicates: a moved active note that duplicates an active note of the target project in the same audience and scope (the same test the write
 * door and `memory dedupe` use) is not left as a second copy: it is moved already expired as `duplicate` (the archive search still finds it) and the
 * kept note records it as one more origin; a moved note that strictly extends a target note supersedes it.
 */
export const MEMORY_MOVE_SECTION_USAGE = "bb lane-pilot memory move-section --from-project P --section <folderId>[,<childFolderId>...] --to-project Q [--to-section <folderId> | --root] [--section-name <name>[,<name>]] [--thread-ids t1,t2] [--apply] [--json]   (dry run unless --apply; --apply is the owner's, at a terminal; it writes a backup of every affected row first)";

type Db = Pick<MemoryDatabase, "prepare" | "transaction">;
type Result = { exitCode: number; stdout?: string; stderr?: string };

/** True for the form that changes the corpus; a thread (an agent) may not call it. */
export const memoryMoveSectionChanges = (argv: readonly string[]): boolean => argv.includes("--apply");

const value = (argv: readonly string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const list = (text: string | undefined) => (text ?? "").split(",").map((item) => item.trim()).filter(Boolean);

export function parseMoveSectionArgs(argv: readonly string[]): MoveSectionOptions | string {
  const fromProject = value(argv, "--from-project"), toProject = value(argv, "--to-project"), sections = list(value(argv, "--section"));
  if (!fromProject || !toProject || !sections.length) return `needs --from-project, --section and --to-project\n${MEMORY_MOVE_SECTION_USAGE}`;
  if (fromProject === toProject) return "--from-project and --to-project are the same project; nothing to move";
  const toSection = value(argv, "--to-section");
  if (toSection && argv.includes("--root")) return "pick one: --to-section or --root";
  return { fromProject, toProject, sections, ...(toSection ? { toSection } : {}), ...(argv.includes("--root") ? { root: true } : {}), names: list(value(argv, "--section-name")), threadIds: list(value(argv, "--thread-ids")) };
}

export function formatMoveSectionPlan(plan: MoveSectionPlan, applied: { backup: string | null; changed: number } | null): string {
  const lines = [`${applied ? "moved" : "would move"} ${plan.sections.join(", ")}: ${plan.from} -> ${plan.to}`];
  const tables = Object.entries(plan.moves).sort(([a], [b]) => a.localeCompare(b));
  for (const [table, n] of tables) lines.push(`  ${table}: ${n}`);
  if (!tables.length) lines.push("  nothing to move");
  if (plan.mergedAsDuplicate) lines.push(`  of the notes, ${plan.mergedAsDuplicate} duplicate a note of ${plan.to} and move expired as duplicate (merged, not copied)`);
  if (plan.supersedesTarget) lines.push(`  of the notes, ${plan.supersedesTarget} extend a note of ${plan.to} and supersede it`);
  for (const [kind, n] of Object.entries(plan.stays)) lines.push(`  stays: ${n} ${kind}`);
  if (plan.rootNotesMentioning !== null) lines.push(`  hint: ${plan.rootNotesMentioning} active notes of the root of ${plan.from} mention the section's name (not moved; read them and move by hand if they belong)`);
  lines.push(applied ? (applied.backup ? `backup of the ${applied.changed} changed rows: ${applied.backup}` : "nothing changed") : "dry run (nothing changed; pass --apply to move)");
  return `${lines.join("\n")}\n`;
}

/** `bb lane-pilot memory move-section`: a dry run unless `--apply`. The caller has already refused `--apply` from a thread. */
export function runMemoryMoveSectionCli(db: Db, argv: readonly string[], writeBackup: (json: string) => string): Result {
  try {
    const options = parseMoveSectionArgs(argv);
    if (typeof options === "string") return { exitCode: 1, stderr: options };
    const plan = planMoveSection(db, options);
    const applied = memoryMoveSectionChanges(argv) ? applyMoveSection(db, plan, writeBackup) : null;
    if (argv.includes("--json")) return { exitCode: 0, stdout: `${JSON.stringify({ from: plan.from, to: plan.to, sections: plan.sections, applied: Boolean(applied), moves: plan.moves, mergedAsDuplicate: plan.mergedAsDuplicate, supersedesTarget: plan.supersedesTarget, stays: plan.stays, rootNotesMentioning: plan.rootNotesMentioning, backup: applied?.backup ?? null }, null, 2)}\n` };
    return { exitCode: 0, stdout: formatMoveSectionPlan(plan, applied) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
