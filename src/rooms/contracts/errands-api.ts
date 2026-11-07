/** The errand surface the schedule board calls, implemented by src/rooms/qa (mountErrands). Keep the two signatures in step with it. */
export type ErrandRunStart = {
  projectId: string; pmThreadId: string | null; runId: string | null;
  /** Names the run: the same key is the same run (a schedule's: the key of its run). */
  key: string;
  task: string; title?: string | undefined; authorized: boolean; accounts: readonly string[];
  plugins?: readonly string[] | undefined; skills?: readonly string[] | undefined; mcp?: readonly string[] | undefined;
  providerId?: string | undefined; model?: string | undefined; reasoning?: string | undefined; serviceTier?: "default" | "fast" | undefined;
  /** The kind of errand (errand-kinds.ts) and who named it (pm, hint, jev, schedule): the row of the role table the helper runs on. */
  kind?: string | undefined; kindBy?: string | undefined;
  /** A hidden thread with no parent chat. */
  detached?: boolean | undefined;
  /** A schedule started it: the helper cannot create schedules, and the thread says which schedule run it is for. */
  schedule?: { id: string; runKey: string } | undefined;
  /** What the router said about the brief (the ledger on the run's inputs; startRun of a schedule leaves both empty). */
  routeTop?: string | undefined; routeWhy?: string | undefined;
};

export interface ErrandsApi {
  resolveAccounts(input: { projectId: string; runId: string | null; pmThreadId: string | null; names: readonly string[]; record?: boolean }): Promise<{ ok: true; accounts: unknown[] } | { ok: false; blocked: { reason: string; fix: string[] } }>;
  startRun(input: ErrandRunStart): { runId: string; created: boolean };
}
