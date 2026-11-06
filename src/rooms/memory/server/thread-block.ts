import { coreShelf, isSharedScope } from "@lane-pilot/memory-core";
import { memorySettingsFor } from "../../self-repair/server";
import type { LanePilotDatabase } from "../../storage";
import type { ServerCore } from "../../core/server";

/**
 * The memory showcase every ordinary BB thread gets (M2): the project's L1 core facts plus the two lines that name the
 * one memory (`lane-memory` over the session RPCs) and the places it must not go. A PM thread keeps its own resume
 * block (learning room), and a thread the plugin spawned for itself (analyzers, helpers, repairs) carries its own
 * context, so both get nothing here.
 */

/** The exact rule the block ends with (and the line AGENTS.md carries). */
export const THREAD_MEMORY_RULE = [
  'Память проекта — Lane Pilot: искать `lane-memory search "<вопрос>"`, записать `lane-memory write …`;',
  "не в файлы ~/.claude/…/memory и не в BB memory",
] as const;

const BLOCK_LIMIT = 1200;
const FACT_LIMIT = 8;
const FACT_CHARS = 160;

/**
 * Whether the plugin itself spawned this thread: the id is recorded in the run/attempt/receipt rows or inside a
 * workflow effect's spawn result. ponytail: a plugin thread no table recorded still gets the block (the block only
 * points at lane-memory, it carries no facts of its own); the upgrade path is a thread registry at spawn time or a
 * pluginMetadata check once contributeInstructions can see it.
 */
export function pluginThread(db: LanePilotDatabase, threadId: string): boolean {
  const row = db.prepare(`SELECT (
    EXISTS(SELECT 1 FROM lane_pilot_run WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_activation WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_attempt WHERE thread_id=? OR holder_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_stage_receipt WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_pm_notice WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_pm_skill_use WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_secret_issuance WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_errand_episode WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_wall_repair WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_learning_obs WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_learning_item WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_wf_effect WHERE result_json LIKE '%' || ? || '%')
  ) AS plugin`).get(threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId) as { plugin: number };
  return row.plugin === 1;
}

const parseScope = (json: string | null): string[] => {
  try {
    const value = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
};

/**
 * The project's L1 for a thread that names no section: the core shelf of the project-wide scopes (the root and the
 * shared `project:*` marks), newest first, at most FACT_LIMIT one-line facts of FACT_CHARS each.
 */
function l1Facts(db: LanePilotDatabase, projectId: string, personalBot: string): string[] {
  const rows = db.prepare(`SELECT DISTINCT scope_json FROM lane_pilot_memory
    WHERE project_id=? AND personal_bot=? AND kind='core' AND audience='subagent' AND status='active'`).all(projectId, personalBot) as Array<{ scope_json: string | null }>;
  const scopes = rows.map((row) => parseScope(row.scope_json))
    .filter((scope) => scope.length === 0 || isSharedScope(scope))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const scope of scopes) {
    // Newest first inside a scope: the showcase shows the freshest conventions, and a just-written fact is never the one cut.
    for (const record of [...coreShelf(db, projectId, personalBot, "subagent", scope).replaceable].reverse()) {
      if (seen.has(record.id) || facts.length >= FACT_LIMIT) continue;
      seen.add(record.id);
      facts.push(record.content.replace(/\s+/g, " ").trim().slice(0, FACT_CHARS));
    }
  }
  return facts;
}

/** Facts as bullets plus the rule, never over BLOCK_LIMIT characters; no facts → the rule alone. */
function renderBlock(facts: readonly string[]): string {
  const rule = THREAD_MEMORY_RULE.join("\n");
  const head = "Память проекта — факты:\n";
  const lines: string[] = [];
  let used = head.length + rule.length + 2;
  for (const fact of facts.slice(0, FACT_LIMIT)) {
    const line = `- ${fact}`;
    if (used + line.length + 1 > BLOCK_LIMIT) continue;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return rule;
  return `${head}${lines.join("\n")}\n${rule}`;
}

/** What an ordinary thread of the project is handed; null for a PM thread, a plugin thread, or a project with memory off. */
export function threadMemoryBlock(db: LanePilotDatabase, input: { projectId: string; threadId: string }): string | null {
  if (pluginThread(db, input.threadId)) return null;
  const settings = memorySettingsFor(db, input.projectId);
  if (!settings.enabled) return null;
  return renderBlock(l1Facts(db, input.projectId, settings.personalBot));
}

/** The second contributeInstructions contributor: the memory showcase for every thread that is not the plugin's own. */
export function mountThreadBlock(ctx: ServerCore): void {
  const { bb, db } = ctx;
  try {
    bb.agents.contributeInstructions(({ threadId, projectId }) => threadMemoryBlock(db, { projectId, threadId }));
  } catch (cause) { bb.log.info(`Lane Pilot memory cannot contribute instructions: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
