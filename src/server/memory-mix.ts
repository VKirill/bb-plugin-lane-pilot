import { searchMemoryRecords, type MemorySearchEngine } from "@lane-pilot/memory-core";
import type { TaskV2 } from "../contracts";
import type { LanePilotDatabase } from "../database";
import { writerMemory, writerMemoryPicks } from "../writer-brief";

type TaskPaths = Pick<TaskV2, "owns_paths" | "read_first">;

/**
 * The notes a writer's brief gets: at most three that name a path of the task, then core conventions, the more
 * useful first. Confirmed rules are left out (the rules block carries them). The caller records the mix once the
 * brief is final (`recordMemoryMixed`), so a mix that never reached a writer is not counted.
 */
export function mixWriterMemory(db: LanePilotDatabase, input: { projectId: string; query: string; task: TaskPaths; searchEngine: MemorySearchEngine; personalBot: string; ruleMemoryIds: ReadonlySet<string> }): { text: string; ids: string[] } {
  const found = searchMemoryRecords(db, input.projectId, input.query, 100, input.searchEngine, "subagent", input.personalBot).filter((record) => !input.ruleMemoryIds.has(record.id));
  return { text: writerMemory(found, input.task), ids: writerMemoryPicks(found, input.task).map((record) => record.id) };
}
