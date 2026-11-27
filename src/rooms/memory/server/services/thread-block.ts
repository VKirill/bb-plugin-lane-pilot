import { coreShelf, isSharedScope } from "@lane-pilot/memory-core";
import { wfEffectMentionsThread, wfNightSpawnMentionsThread } from "@lane-pilot/workflow-engine";
import type { ManualMode } from "../../../contracts";
import { memorySettingsFor } from "./memory-settings";
import { loadProjectSettings, pluginThreadInStoreTables, silentThreadInStoreTables, type LanePilotDatabase } from "../../../storage";
import { listCoreScopes } from "../repositories/memory-queries";
import { THREAD_MEMORY_RULE } from "../../../contracts/thread-rule";

/** The exact rule the block ends with (and the line AGENTS.md carries); the constant itself lives in the leaf `contracts/thread-rule`. */
export { THREAD_MEMORY_RULE };

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
  return pluginThreadInStoreTables(db, threadId)
    || wfEffectMentionsThread(db, threadId);
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
 * Under `memory.scope = project` every core scope of the project counts, not only the project-wide ones.
 */
function l1Facts(db: LanePilotDatabase, projectId: string, personalBot: string, scopeMode: "section" | "project" = "section"): string[] {
  const rows = listCoreScopes(db, projectId, personalBot);
  const scopes = rows.map((row) => parseScope(row.scope_json))
    .filter((scope) => scopeMode === "project" || scope.length === 0 || isSharedScope(scope))
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

/** A PM thread (its own memory block and tool) or a hidden analyzer (no tools): both get no block. */
function silentThread(db: LanePilotDatabase, threadId: string): boolean {
  return silentThreadInStoreTables(db, threadId) || wfNightSpawnMentionsThread(db, threadId);
}

/**
 * What a thread of the project is handed: facts + rule for an ordinary thread, the rule alone for the pilot's own working
 * threads, null for a PM thread, a hidden analyzer, or a project with memory off. ponytail: a thread is known by the rows
 * that record it, and a spawn records its id after the thread starts, so a just-spawned analyzer can still get the rule;
 * its own prompt forbids tools. Upgrade: pluginMetadata in contributeInstructions.
 */
export function threadMemoryBlock(
  db: LanePilotDatabase,
  input: { projectId: string; threadId: string; manualMode?: Pick<ManualMode, "on">; log?: (message: string) => void },
): string | null {
  // «Ручной режим»: do not inject memory instructions into BB threads on our own while manual.
  if (input.manualMode?.on()) {
    input.log?.(`memory thread block skipped for ${input.threadId}: manual mode`);
    return null;
  }
  if (silentThread(db, input.threadId)) return null;
  const settings = memorySettingsFor(loadProjectSettings(db, input.projectId));
  if (!settings.enabled) return null;
  if (pluginThread(db, input.threadId)) return THREAD_MEMORY_RULE.join("\n");
  return renderBlock(l1Facts(db, input.projectId, settings.personalBot, settings.scope ?? "section"));
}
