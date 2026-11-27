/**
 * Exports published non-built-in workflows and hub-evolved built-ins from `lane_pilot_wf_definition` into `workflows/<id>.json`.
 * Never commits; refuses when `git status --porcelain workflows/` has uncommitted changes unless `--force`.
 *
 *   npx tsx scripts/export-hub-graphs.ts [--db <path>] [--force] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  archivedDefinition,
  definitionSha256,
  listLatestHubDefinitions,
  loadWorkflow,
  parseWorkflowObject,
  type HubDefinitionRow,
  type Workflow,
} from "../packages/workflow-engine/src/index";

const ROOT = resolve(import.meta.dirname, "..");

export const DEFAULT_HUB_DB_PATH =
  process.env.LP_HUB_DB ||
  process.env.LP_DRILL_HUB_DB ||
  "/home/ubuntu/.bb/plugins/lane-pilot/data.db";

export type ExportedGraphFile = {
  workflowId: string;
  version: number;
  path: string;
  action: "created" | "updated";
};

export type ExportHubGraphsOptions = {
  dbPath?: string;
  workflowsDir?: string;
  force?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  markExported?: () => Promise<void> | void;
};

export type ExportHubGraphsResult = {
  exported: ExportedGraphFile[];
  unchanged: string[];
  dryRun: boolean;
};

function parseRawWorkflowJson(row: HubDefinitionRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.definitionJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("definition_json must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid JSON for workflow "${row.workflowId}": ${msg}`);
  }
}

function readDiskWorkflows(workflowsDir: string): Map<string, Workflow> {
  const map = new Map<string, Workflow>();
  if (!existsSync(workflowsDir)) return map;
  for (const name of readdirSync(workflowsDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const text = readFileSync(join(workflowsDir, name), "utf8");
      const parsed = parseWorkflowObject(JSON.parse(text));
      if (parsed.success) map.set(parsed.data.id, parsed.data);
    } catch {
      // Unrelated broken files on disk are ignored during subworkflow lookup.
    }
  }
  return map;
}

function checkCleanWorkflowsGitTree(workflowsDir: string): void {
  const probeDir = existsSync(workflowsDir) ? workflowsDir : dirname(workflowsDir);
  if (!existsSync(probeDir)) return;
  let topLevel = "";
  try {
    topLevel = execFileSync("git", ["-C", probeDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // Not inside a git worktree (e.g. isolated temp dir).
    return;
  }
  if (!topLevel) return;
  const rel = relative(topLevel, workflowsDir) || ".";
  const status = execFileSync("git", ["-C", topLevel, "status", "--porcelain", "--", rel], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (status) {
    throw new Error(
      `refused: uncommitted changes in ${rel} (pass --force to overwrite):\n${status}`,
    );
  }
}

function defaultMarkExported(warn: (line: string) => void): void {
  const bbBin = process.env.BB_CLI || "bb";
  try {
    execFileSync(bbBin, ["lane-pilot", "graphs", "mark-exported"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    warn(`warn: bb lane-pilot graphs mark-exported skipped (${msg})`);
  }
}

/**
 * Exports hub-evolved built-ins and newly published graphs from `lane_pilot_wf_definition`
 * into `workflows/<id>.json` after schema validation.
 */
export async function exportHubGraphs(
  options: ExportHubGraphsOptions = {},
): Promise<ExportHubGraphsResult> {
  const dbPath = options.dbPath ?? DEFAULT_HUB_DB_PATH;
  const workflowsDir = resolve(options.workflowsDir ?? join(ROOT, "workflows"));
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.error(line));

  if (!dryRun && !force) {
    checkCleanWorkflowsGitTree(workflowsDir);
  }
  if (!existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath} (pass --db <path>)`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const toWrite: Array<{ entry: ExportedGraphFile; content: string }> = [];
  const unchanged: string[] = [];

  try {
    const rows = listLatestHubDefinitions(db);
    const parsedRaws = new Map<string, Record<string, unknown>>();
    const hubParsed = new Map<string, Workflow>();

    for (const row of rows) {
      const raw = parseRawWorkflowJson(row);
      const parsed = parseWorkflowObject(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "workflow"}: ${issue.message}`)
          .join("; ");
        throw new Error(`schema-invalid definition for "${row.workflowId}": ${detail}`);
      }
      if (parsed.data.id !== row.workflowId) {
        throw new Error(
          `workflow id mismatch: row has "${row.workflowId}" but definition_json has "${parsed.data.id}"`,
        );
      }
      parsedRaws.set(row.workflowId, raw);
      hubParsed.set(row.workflowId, parsed.data);
    }

    const diskMap = readDiskWorkflows(workflowsDir);
    const resolveWorkflow = (id: string, version?: number): Workflow | null => {
      const fromHub = hubParsed.get(id);
      if (fromHub && (version === undefined || fromHub.version === version)) return fromHub;
      const fromDisk = diskMap.get(id);
      if (fromDisk && (version === undefined || fromDisk.version === version)) return fromDisk;
      if (version !== undefined) return archivedDefinition(db, id, version);
      return null;
    };

    for (const row of rows) {
      const raw = parsedRaws.get(row.workflowId)!;
      const loaded = loadWorkflow(raw, { resolve: resolveWorkflow });
      if (!loaded.ok) {
        const detail = loaded.problems
          .filter((problem) => problem.level === "error")
          .map((problem) => problem.message)
          .join("; ");
        throw new Error(`schema-invalid definition for "${row.workflowId}": ${detail}`);
      }
      const hubSha = definitionSha256(loaded.workflow);
      const targetPath = join(workflowsDir, `${loaded.workflow.id}.json`);
      const existed = existsSync(targetPath);

      if (existed) {
        const existingText = readFileSync(targetPath, "utf8");
        const existingLoaded = loadWorkflow(existingText);
        if (existingLoaded.ok && definitionSha256(existingLoaded.workflow) === hubSha) {
          unchanged.push(loaded.workflow.id);
          continue;
        }
      }

      const content = `${JSON.stringify(raw, null, 2)}\n`;
      toWrite.push({
        entry: {
          workflowId: loaded.workflow.id,
          version: loaded.workflow.version,
          path: targetPath,
          action: existed ? "updated" : "created",
        },
        content,
      });
    }
  } finally {
    db.close();
  }

  if (!dryRun) {
    if (toWrite.length > 0) {
      mkdirSync(workflowsDir, { recursive: true });
      for (const item of toWrite) {
        writeFileSync(item.entry.path, item.content, "utf8");
      }
    }
    if (options.markExported) {
      await options.markExported();
    } else {
      defaultMarkExported(warn);
    }
  }

  for (const item of toWrite) {
    const label = relative(ROOT, item.entry.path);
    const displayPath = label.startsWith("..") ? item.entry.path : label;
    log(`${dryRun ? "would export" : "exported"} ${displayPath} (${item.entry.action} v${item.entry.version})`);
  }
  log(`exported ${toWrite.length} graphs, unchanged ${unchanged.length}${dryRun ? " (dry-run)" : ""}`);

  return {
    exported: toWrite.map((item) => item.entry),
    unchanged,
    dryRun,
  };
}

function parseCliArgs(argv: string[]): ExportHubGraphsOptions {
  const opts: ExportHubGraphsOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--db") {
      const next = argv[i + 1];
      if (!next) throw new Error("--db requires a path");
      opts.dbPath = next;
      i += 1;
    } else if (arg === "--workflows-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--workflows-dir requires a path");
      opts.workflowsDir = next;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}\nusage: npx tsx scripts/export-hub-graphs.ts [--db <path>] [--force] [--dry-run]`);
    }
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  exportHubGraphs(parseCliArgs(process.argv.slice(2))).catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  });
}
