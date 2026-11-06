import { readFileSync } from "node:fs";
import { memorySettingsFor } from "../../self-repair/server";
import type { LanePilotDatabase } from "../../storage";
import { evalMemoryImport, formatImportEval, formatImportSummary, MEMORY_IMPORT_SOURCES, MEMORY_IMPORT_USAGE,
  pmTopIds, readImportReport, runMemoryImport, writeImportReport, type MemoryImportSource } from "./import";

type Result = { exitCode: number; stdout?: string; stderr?: string };

const VALUE_FLAGS = new Set(["source", "file", "project", "report"]);
const BOOL_FLAGS = new Set(["dry-run", "json"]);

function parseArgs(args: readonly string[]): { values: Map<string, string>; bools: Set<string> } {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(MEMORY_IMPORT_USAGE);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq >= 0 ? eq : undefined);
    if (VALUE_FLAGS.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++index];
      if (value === undefined) throw new Error(MEMORY_IMPORT_USAGE);
      values.set(name, value);
    } else if (BOOL_FLAGS.has(name) && eq < 0) bools.add(name);
    else throw new Error(`unknown flag --${name}\n${MEMORY_IMPORT_USAGE}`);
  }
  return { values, bools };
}

/** `bb lane-pilot memory import|import-eval ...`; `args` is everything after `memory`. */
export function runMemoryImportCli(db: LanePilotDatabase, args: readonly string[]): Result {
  try {
    const [sub, ...rest] = args;
    const { values, bools } = parseArgs(rest);
    if (sub === "import") {
      const source = values.get("source") as MemoryImportSource | undefined;
      const file = values.get("file");
      const project = values.get("project");
      if (!source || !MEMORY_IMPORT_SOURCES.includes(source) || !file || !project) throw new Error(MEMORY_IMPORT_USAGE);
      const settings = memorySettingsFor(db, project);
      const report = runMemoryImport({ db, projectId: project, source, jsonl: readFileSync(file, "utf8"), settings, dryRun: bools.has("dry-run") });
      const path = writeImportReport(report);
      if (bools.has("json")) return { exitCode: 0, stdout: JSON.stringify({ ...report, reportPath: path }, null, 2) };
      const lines = report.dryRun ? report.outcomes.map((outcome) => `${outcome.outcome === "dropped" ? "dropped" : outcome.outcome === "added" ? `added ${outcome.id}` : `merged_with ${outcome.id}`}${outcome.reason ? ` (${outcome.reason})` : ""} ${outcome.source_id}`) : [];
      return { exitCode: 0, stdout: [...lines, formatImportSummary(report, path)].join("\n") };
    }
    if (sub === "import-eval") {
      const reportPath = values.get("report");
      if (!reportPath) throw new Error(MEMORY_IMPORT_USAGE);
      const report = readImportReport(reportPath);
      const settings = memorySettingsFor(db, report.projectId);
      const result = evalMemoryImport(report, (query) => pmTopIds(db, report.projectId, query, settings));
      return { exitCode: 0, stdout: bools.has("json") ? JSON.stringify(result, null, 2) : formatImportEval(result) };
    }
    throw new Error(MEMORY_IMPORT_USAGE);
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
