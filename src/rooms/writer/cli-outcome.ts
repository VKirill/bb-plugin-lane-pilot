// (2026-10-29) classifyCliOutcome went with the CLI conveyor. Dirt snapshots stay for writer verification.
// DirtSnapshot/parseDirtSnapshots live in the rooms-level dirt module (storage owns the lane_pilot_attempt dirt_before_json column); re-exported for writer callers.
import type { DirtSnapshot } from "../dirt-snapshot";
export { parseDirtSnapshots } from "../dirt-snapshot";
export type { DirtSnapshot } from "../dirt-snapshot";

function asSnapshots(rows: DirtSnapshot[] | string[]): DirtSnapshot[] {
  return rows.map((row) => typeof row === "string" ? { path:row, sha256:"" } : row);
}

export function attemptProduced(after: DirtSnapshot[] | string[], before: DirtSnapshot[] | string[]): string[] {
  const afterFiles = asSnapshots(after);
  const beforeFiles = asSnapshots(before);
  const hashed = [...afterFiles, ...beforeFiles].some((file) => file.sha256.length > 0);
  if (!hashed) {
    const previous = new Set(beforeFiles.map((file) => file.path));
    return afterFiles.map((file) => file.path).filter((path) => !previous.has(path));
  }
  const previous = new Map(beforeFiles.map((file) => [file.path, file.sha256]));
  const current = new Map(afterFiles.map((file) => [file.path, file.sha256]));
  const produced = new Set<string>();
  for (const file of afterFiles) {
    if (!previous.has(file.path) || previous.get(file.path) !== file.sha256) produced.add(file.path);
  }
  for (const file of beforeFiles) {
    if (!current.has(file.path)) produced.add(file.path);
  }
  return [...produced];
}
