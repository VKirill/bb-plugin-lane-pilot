/**
 * Re-reading the runs the panel already holds. `list_runs` takes at most 200 runs per call (the contract), and the panel's window
 * grows by a page of 20 every time the owner asks for more: one call of `limit = window` was refused from the 211th run on, the
 * error was swallowed, and the panel stopped refreshing (audit 2026-10-08 round 4, item 22). The window is read in pages instead.
 */
export const RUNS_MAX_LIMIT = 200;

type RunsPage = { runs: unknown[]; total: number };
type Rpc = { call(method: "list_runs", input: Record<string, unknown>): Promise<RunsPage> };

/** The newest `window` runs, in pages of at most 200; the open runs beyond the window ride along with the first page. */
export async function readRunsWindow(rpc: Rpc, scope: Record<string, unknown>, window: number): Promise<RunsPage> {
  const wanted = Math.max(window, 1);
  const seen = new Set<string>();
  const runs: unknown[] = [];
  let total = 0;
  for (let offset = 0; offset < wanted; offset += RUNS_MAX_LIMIT) {
    const page = await rpc.call("list_runs", { ...scope, offset, limit: Math.min(RUNS_MAX_LIMIT, wanted - offset), ...(offset === 0 ? { pinOpen: true } : {}) });
    total = page.total;
    for (const run of page.runs) {
      const id = (run as { id?: unknown }).id;
      if (typeof id === "string") { if (seen.has(id)) continue; seen.add(id); }
      runs.push(run);
    }
    if (offset + RUNS_MAX_LIMIT >= page.total) break;
  }
  return { runs, total };
}
