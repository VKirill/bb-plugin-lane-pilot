/**
 * The end of a maintenance graph tells the truth about its work: a stage that failed, was blocked or never finished fails the graph run,
 * so the wall and the journal see it. The accepted task is never touched by this; the failure belongs to the graph run alone.
 */
const RED = new Set(["failed", "blocked", "running", "error", "unknown"]);

export type StageVerdict = { stage: string; state: string; reason?: string };

/** Throws, naming every red stage, when any of them is not green; returns otherwise. `red` replaces the states that count as red. */
export function requireGreen(graph: string, stages: readonly StageVerdict[], red: ReadonlySet<string> = RED): void {
  const bad = stages.filter((item) => red.has(item.state));
  if (!bad.length) return;
  const kind = bad.some((item) => item.state === "blocked") ? "blocked" : "failed";
  throw new Error(`${graph}_${kind}: ${bad.map((item) => `${item.stage} ${item.state === "running" ? "did not finish" : item.state}${item.reason ? ` (${item.reason})` : ""}`).join("; ")}`);
}
