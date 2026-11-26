import type { MemoryDatabase } from "@lane-pilot/memory-core";
import { dedupeProject, dropMemoryIndexes, duplicatePairs } from "@lane-pilot/memory-core";
import { projectsWithNotes } from "../repositories/memory-queries";

export { projectsWithNotes };

export function dedupeSingleProject(db: MemoryDatabase, projectId: string, apply: boolean) {
  return dedupeProject(db, projectId, { apply, unindex: (p, id) => dropMemoryIndexes(db, p, id) });
}

export function findProjectDuplicates(db: MemoryDatabase, projectId: string) {
  return duplicatePairs(db, projectId);
}

/**
 * The nightly pass: merges every project's near-duplicate notes with no owner step (the write door misses a meaning copy when the text could not be
 * embedded at write time). Nothing is deleted: a copy goes to the archive, which the search still reads. Returns the merged count per project.
 */
export function dedupeAllProjects(db: MemoryDatabase, now = Date.now()): Array<{ projectId: string; merged: number }> {
  const out: Array<{ projectId: string; merged: number }> = [];
  for (const projectId of projectsWithNotes(db)) {
    const done = dedupeProject(db, projectId, { apply: true, now, unindex: (p, id) => dropMemoryIndexes(db, p, id) });
    if (done.merged.length) out.push({ projectId, merged: done.merged.length });
  }
  return out;
}
