import type { MemoryDatabase } from "@lane-pilot/memory-core";
import { dedupeProject, dropMemoryIndexes, duplicatePairs } from "@lane-pilot/memory-core";

export const MEMORY_DUPLICATES_USAGE = "bb lane-pilot memory duplicates [--project P] [--json]   (read-only: near-duplicate active notes, cosine >= 0.92 or text containment >= 0.9) | memory dedupe --project P [--apply]   (dry run unless --apply; --apply is the owner's, at a terminal)";

type Result = { exitCode: number; stdout?: string; stderr?: string };

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 120);

/** True for the form that changes the corpus; a thread (an agent) may not call it. */
export const memoryDedupeChanges = (argv: readonly string[]): boolean => argv.includes("--apply");

/** Projects that have active notes: the audit without `--project` reads all of them. */
function projectsWithNotes(db: MemoryDatabase): string[] {
  return (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_memory WHERE kind='note' AND status='active' ORDER BY project_id").all() as Array<{ project_id: string }>).map((row) => row.project_id);
}

/**
 * `memory duplicates`: the near-duplicate pairs per project, read-only. `memory dedupe`: the same pairs merged (a copy leaves the shelf with
 * `expired_reason=duplicate`, stays in the archive; the kept note records its origin); dry run unless `--apply`.
 */
export function runMemoryDuplicatesCli(db: MemoryDatabase, sub: "duplicates" | "dedupe", argv: readonly string[], projectId: string | undefined): Result {
  try {
    const json = argv.includes("--json");
    if (sub === "dedupe") {
      if (!projectId) return { exitCode: 1, stderr: `no project: pass --project <id>\n${MEMORY_DUPLICATES_USAGE}` };
      const done = dedupeProject(db, projectId, { apply: argv.includes("--apply"), unindex: (p, id) => dropMemoryIndexes(db, p, id) });
      if (json) return { exitCode: 0, stdout: `${JSON.stringify({ projectId, applied: done.applied, pairs: done.pairs.length, merged: done.merged }, null, 2)}\n` };
      const lines = done.merged.map((item) => `${item.relation === "extends" ? "supersede" : "expire"} ${item.copy.slice(0, 12)} -> kept ${item.keep.slice(0, 12)}`);
      return { exitCode: 0, stdout: `${lines.join("\n")}${lines.length ? "\n" : ""}${done.applied ? "applied" : "dry run (nothing changed; pass --apply)"}: ${done.pairs.length} pairs, ${done.merged.length} notes merged\n` };
    }
    const projects = projectId ? [projectId] : projectsWithNotes(db);
    const report = projects.map((id) => ({ projectId: id, pairs: duplicatePairs(db, id) })).filter((item) => projectId || item.pairs.length);
    if (json) return { exitCode: 0, stdout: `${JSON.stringify(report.map((item) => ({ projectId: item.projectId, count: item.pairs.length, pairs: item.pairs.map(({ keepText, copyText, ...rest }) => ({ ...rest, keepText: clip(keepText), copyText: clip(copyText) })) })), null, 2)}\n` };
    const out: string[] = [];
    for (const item of report) {
      out.push(`${item.projectId}: ${item.pairs.length} near-duplicate pairs`);
      for (const pair of item.pairs.slice(0, 5)) out.push(`  ${pair.relation} keep ${pair.keep.slice(0, 12)} copy ${pair.copy.slice(0, 12)} cosine ${pair.cosine === null ? "n/a" : pair.cosine.toFixed(3)} containment ${pair.containment.toFixed(2)}\n    keep: ${clip(pair.keepText)}\n    copy: ${clip(pair.copyText)}`);
    }
    return { exitCode: 0, stdout: `${out.length ? out.join("\n") : "no near-duplicate pairs"}\n` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
