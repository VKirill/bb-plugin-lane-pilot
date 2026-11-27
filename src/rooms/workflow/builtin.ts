import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { MIN_GRAPH_DESCRIPTION_LENGTH } from "@lane-pilot/contracts";
import type { ArchiveLogger, GraphDriftEntry, Workflow } from "@lane-pilot/workflow-engine";
import {
  archiveDefinitionBatch,
  archivedDefinition,
  definitionSha256,
  findHubDefinitionDrift,
  listLatestHubDefinitions,
  parseWorkflow,
  validateWorkflow,
  WorkflowError,
} from "@lane-pilot/workflow-engine";
import { gateVocabularyLines } from "../contracts";
import { workflowCategory } from "./models/categories";

/** The planner's instructions with the gate vocabulary: the plan's acceptance items are judged by those words (tasks/gate-vocabulary.ts). */
const withGateVocabulary = (workflow: { nodes: Array<{ id: string; prompt?: string }> }): unknown => ({
  ...workflow,
  nodes: workflow.nodes.map((node) => (node.id === "plan" && node.prompt ? { ...node, prompt: `${node.prompt}\n\n${gateVocabularyLines().join("\n")}` } : node)),
});

export type BuiltinLibraryLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type BuiltinLibraryLoadResult = {
  sources: ReadonlyArray<{ name: string; value: unknown }>;
  workflows: Workflow[];
  byId: ReadonlyMap<string, Workflow>;
  rawById: ReadonlyMap<string, Record<string, unknown>>;
  categories: ReadonlySet<string>;
  warnings: string[];
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolves `workflows/` whether running from source (`src/rooms/workflow/server/repositories/builtin.ts`) or bundled (`dist/server.js`). */
export function defaultWorkflowsDir(): string {
  const candidates = [
    join(HERE, "../../../../../workflows"),
    join(HERE, "../../../workflows"),
    join(HERE, "../workflows"),
    join(HERE, "workflows"),
    join(process.cwd(), "workflows"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".json"))) return dir;
  }
  return candidates[0]!;
}

function hasExplicitCategory(raw: Record<string, unknown>): boolean {
  const cat = raw.category;
  if (typeof cat === "string") return cat.trim().length > 0;
  if (cat && typeof cat === "object" && !Array.isArray(cat)) {
    const id = (cat as { id?: unknown }).id;
    return typeof id === "string" && id.trim().length > 0;
  }
  return false;
}

function minDescriptionLengthOf(raw: Record<string, unknown>): number {
  const desc = raw.description;
  if (typeof desc === "string") return desc.trim().length;
  if (desc && typeof desc === "object" && !Array.isArray(desc)) {
    const { en, ru } = desc as { en?: unknown; ru?: unknown };
    const lengths = [en, ru]
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().length);
    return lengths.length ? Math.min(...lengths) : 0;
  }
  return 0;
}

/**
 * Loads every `workflows/*.json` file from `dir` without a hand-maintained import list.
 * Emits `INFO workflow.library loaded graphs=n categories=n` and `WARN` once per missing category or short description.
 */
export function loadBuiltinSourcesFromDir(
  dir = defaultWorkflowsDir(),
  options: { log?: BuiltinLibraryLogger; minDescriptionLength?: number } = {},
): BuiltinLibraryLoadResult {
  const minLen = options.minDescriptionLength ?? MIN_GRAPH_DESCRIPTION_LENGTH;
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  const sources: Array<{ name: string; value: unknown }> = [];
  const parsed = new Map<string, Workflow>();
  const rawById = new Map<string, Record<string, unknown>>();
  const warnings: string[] = [];

  // Pass 1: parse every workflow file structure without cross-workflow lookup.
  for (const name of files) {
    const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    const value = name === "lp.plan.json" || raw.id === "lp.plan" ? withGateVocabulary(raw as never) : raw;
    const workflow = parseWorkflow(value);
    if (!hasExplicitCategory(raw)) {
      warnings.push(`workflow.library missing category id=${workflow.id} file=${name}`);
    }
    const descLen = minDescriptionLengthOf(raw);
    if (descLen < minLen) {
      warnings.push(`workflow.library short description id=${workflow.id} len=${descLen} min=${minLen} file=${name}`);
    }
    sources.push({ name, value });
    parsed.set(workflow.id, workflow);
    rawById.set(workflow.id, value as Record<string, unknown>);
  }

  // Pass 2: validate subworkflows, output fields, and bridges against the complete set.
  const resolveBuiltin = (id: string, version?: number): Workflow | null => {
    const found = parsed.get(id) ?? null;
    return found && (version === undefined || found.version === version) ? found : null;
  };
  for (const workflow of parsed.values()) {
    const errs = validateWorkflow(workflow, { resolve: resolveBuiltin }).filter((problem) => problem.level === "error");
    if (errs.length) throw new WorkflowError(errs);
  }

  const workflows = [...parsed.values()];
  const categories = new Set(workflows.map((workflow) => workflowCategory(workflow)));
  options.log?.info?.(`workflow.library loaded graphs=${workflows.length} categories=${categories.size}`);
  for (const warning of warnings) options.log?.warn?.(warning);

  return { sources, workflows, byId: parsed, rawById, categories, warnings };
}

const loaded = loadBuiltinSourcesFromDir();

/** The workflows that ship with Lane Pilot (`workflows/*.json`, loaded from the directory). */
export const BUILTIN_SOURCES: ReadonlyArray<{ name: string; value: unknown }> = loaded.sources;

export { LP_TASK_PIPELINE, AFTER_ACCEPT, SELF_REPAIR, ANALYZE_PLAN_EXECUTE } from "../contracts";

/** Emit the startup INFO summary and any one-time WARN notices for the shipped graph library. */
export function logBuiltinLibraryStatus(logger: BuiltinLibraryLogger): void {
  logger.info?.(`workflow.library loaded graphs=${loaded.workflows.length} categories=${loaded.categories.size}`);
  for (const warning of loaded.warnings) logger.warn?.(warning);
}

/**
 * Domain/specialist craft built-in workflows that may evolve via `~/.lane-pilot/workflows/<id>.json` global overlays
 * ONLY when owner feedback (`trajectory_delta`) targets them. Core orchestration, coding, phase, and `lp.*` built-ins
 * are strictly excluded (`isCoreLockedBuiltinId`).
 */
export const EVOLVABLE_DOMAIN_BUILTIN_IDS: ReadonlySet<string> = new Set([
  // SEO specialist craft workflows
  "seo-ai-visibility", "seo-brief", "seo-cocoon", "seo-drop-diagnosis", "seo-linkbuilding",
  "seo-mentions", "seo-monitor", "seo-outreach", "seo-page", "seo-page-refresh",
  "seo-project-intake", "seo-release", "seo-research", "seo-structure-audit", "seo-tech-audit",
  "seo-template-scale", "seo-trust",
  // Growth marketing craft workflows
  "mkt-direct-search-campaign", "mkt-experiment-cycle", "mkt-landing-cro-audit", "mkt-project-intake",
  "mkt-pulse-monitor", "mkt-tg-ads-campaign", "mkt-tracking-setup",
  // Content, research & creative media craft workflows
  "social-post", "insights-post", "ins.post", "x-to-telegram-digest", "web-research",
  "research-dossier", "api-recon", "reels", "3d-asset", "roblox-asset",
  // Business & delivery craft workflows
  "invoice-send", "telegram-send",
]);

let archiveDb: Database.Database | null = null;

/** Binds the archive database used when `builtinWorkflow(id, version)` falls back to an older archived revision. */
export const setBuiltinArchiveDb = (db: Database.Database | null): void => {
  archiveDb = db;
};

/** Archives every built-in workflow definition into `lane_pilot_wf_definition` at startup (`INSERT OR IGNORE`). */
export function archiveBuiltinWorkflows(db: Database.Database, log?: ArchiveLogger): number {
  archiveDb = db;
  return archiveDefinitionBatch(
    db,
    loaded.workflows.map((wf) => ({
      workflowId: wf.id,
      version: wf.version,
      sha: definitionSha256(wf),
      json: JSON.stringify(wf),
      scope: "builtin",
    })),
    { log, bestEffort: true },
  );
}

export const builtinWorkflows = (): Workflow[] => [...loaded.workflows];
export const builtinWorkflow = (id: string, version?: number, db?: Database.Database): Workflow | null => {
  const found = loaded.byId.get(id) ?? null;
  if (found && (version === undefined || found.version === version)) return found;
  if (version !== undefined) {
    const targetDb = db ?? archiveDb;
    if (targetDb) return archivedDefinition(targetDb, id, version);
  }
  return null;
};
export const isEvolvableDomainBuiltinId = (id: string): boolean => EVOLVABLE_DOMAIN_BUILTIN_IDS.has(id.trim());
export const isCoreLockedBuiltinId = (id: string): boolean => {
  const trimmed = id.trim();
  return loaded.byId.has(trimmed) && !EVOLVABLE_DOMAIN_BUILTIN_IDS.has(trimmed);
};
export const rawBuiltinWorkflowSource = (id: string): Record<string, unknown> | null => {
  const raw = loaded.rawById.get(id.trim());
  return raw ? (JSON.parse(JSON.stringify(raw)) as Record<string, unknown>) : null;
};

/**
 * Compares the newest non-built-in hub definitions in `lane_pilot_wf_definition` against `workflows/<id>.json`.
 * Returns graphs missing from `workflows/` or whose loaded SHA-256 differs from the hub revision.
 */
export function listWorkflowGitDrift(
  db: Database.Database,
  options: { workflowsDir?: string } = {},
): GraphDriftEntry[] {
  const dir = options.workflowsDir ?? defaultWorkflowsDir();
  const hubRows = listLatestHubDefinitions(db);
  return findHubDefinitionDrift(hubRows, (workflowId) => {
    const filePath = join(dir, `${workflowId}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  });
}
