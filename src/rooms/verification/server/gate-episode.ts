import { fileAllowedByOwns } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../../storage";
import { listLiveTasksForRun } from "../../storage";

/**
 * A red-gate episode: one gate command that keeps failing on the same test files, until a gate run is green. The owner is
 * asked once per episode; later red runs of the same episode only tell the PM, and not even that while a PM fix task that
 * touches the failing tests is in flight (live 2026-10-09: the same form reached the owner three times).
 */
export type GateEpisode = {
  command: string;
  /** Every failing file seen in the episode. */
  files: string[];
  startedAt: number;
  /** The owner's answer was handed to the PM; a second one for the same episode is dropped. */
  answered: boolean;
};

const norm = (path: string) => path.replace(/^\.\//, "").replace(/\\/g, "/").trim();

/**
 * The same episode when the command is the same and the files that fail now are among those that failed before (a fix in
 * progress shrinks the set; it does not start a new question). A run whose failing files could not be read continues only
 * an episode that had none either.
 */
export function continuesEpisode(episode: GateEpisode | null | undefined, command: string, files: string[]): boolean {
  if (!episode || episode.command !== command) return false;
  if (files.length === 0 || episode.files.length === 0) return files.length === 0 && episode.files.length === 0;
  const known = new Set(episode.files.map(norm));
  return files.every((file) => known.has(norm(file)));
}

/** Whether a task's owns_paths or expected_outputs cover a failing test file (the file as the runner printed it may be workspace-relative). */
export function taskCoversFile(contract: unknown, file: string): boolean {
  const record = (contract ?? {}) as { owns_paths?: unknown; expected_outputs?: unknown };
  const patterns = [record.owns_paths, record.expected_outputs]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((entry): entry is string => typeof entry === "string").map(norm);
  const target = norm(file);
  return patterns.some((pattern) => {
    const folder = pattern.replace(/\/?\*{0,2}$/, "").replace(/\/$/, "");
    return pattern === target || fileAllowedByOwns(target, [pattern]) || (folder !== "" && (target.startsWith(`${folder}/`) || folder.endsWith(`/${target}`) || folder.endsWith(`/${target.split("/").slice(0, -1).join("/")}`)));
  });
}

/**
 * The run's tasks that are being worked on now and are a fix for this episode: they cover a failing file, or were dispatched
 * after the episode began. The tasks just merged into the gate's batch are not fixes in flight.
 */
export function fixesInFlight(db: LanePilotDatabase, runId: string, files: string[], episodeStartedAt: number, mergedTaskIds: string[]): string[] {
  const live = new Set(listLiveTasksForRun(db, runId).map((task) => task.id));
  const merged = new Set(mergedTaskIds);
  const rows = db.prepare("SELECT id, contract_json, created_at FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string; contract_json: string; created_at: number }>;
  const found: string[] = [];
  for (const row of rows) {
    if (!live.has(row.id) || merged.has(row.id)) continue;
    let contract: unknown = null;
    try { contract = JSON.parse(row.contract_json); } catch { /* an unreadable contract only counts by its age */ }
    if (row.created_at > episodeStartedAt || files.some((file) => taskCoversFile(contract, file))) found.push(row.id);
  }
  return found;
}
