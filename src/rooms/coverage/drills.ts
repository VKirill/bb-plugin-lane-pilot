import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DrillSummary = {
  file: string;
  date: string | null;
  stamp: string | null;
  finishedAt: number | null;
  durationSec: number | null;
  mode: string | null;
  result: string;
  passedCount: number;
  totalCount: number;
  problems: string[];
};

export function drillsDir(cwd: string = process.cwd()): string {
  return join(cwd, ".agents", "runs", "drills");
}

export function listDrillReceiptFiles(cwd: string = process.cwd()): string[] {
  const dir = drillsDir(cwd);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
}

/** Reads the newest drill receipts from `.agents/runs/drills` for read-only health display. */
export function listRecentDrills(cwd: string = process.cwd(), limit = 10): DrillSummary[] {
  const dir = drillsDir(cwd);
  const files = listDrillReceiptFiles(cwd).slice(-limit).reverse();
  const out: DrillSummary[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        date?: unknown;
        stamp?: unknown;
        finishedAt?: unknown;
        durationSec?: unknown;
        mode?: unknown;
        result?: unknown;
        scenarios?: unknown;
        scenarioNames?: unknown;
        problems?: unknown;
      };
      const scenarios = Array.isArray(raw.scenarios)
        ? raw.scenarios.filter((s): s is { result?: unknown } => Boolean(s && typeof s === "object"))
        : [];
      const scenarioNames = Array.isArray(raw.scenarioNames) ? raw.scenarioNames : [];
      const totalCount = scenarios.length || scenarioNames.length;
      const passedCount = scenarios.filter((s) => s.result === "pass").length;
      const problems = Array.isArray(raw.problems)
        ? raw.problems.filter((p): p is string => typeof p === "string").slice(0, 5)
        : [];
      out.push({
        file,
        date: typeof raw.date === "string" ? raw.date : null,
        stamp: typeof raw.stamp === "string" ? raw.stamp : null,
        finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : null,
        durationSec: typeof raw.durationSec === "number" ? raw.durationSec : null,
        mode: typeof raw.mode === "string" ? raw.mode : null,
        result: typeof raw.result === "string" ? raw.result : "unknown",
        passedCount,
        totalCount,
        problems,
      });
    } catch {
      // Skip malformed JSON files so one bad receipt does not break the list.
    }
  }
  return out;
}
