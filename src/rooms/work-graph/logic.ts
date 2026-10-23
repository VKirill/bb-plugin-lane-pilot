/**
 * The work graph of a task as the owner reads it (Matvey Maslov's «Работы / Этапы и модели» screens, 2026-10-23): one cell per stage
 * that ran (green passed, red failed, a badge when it took more than one round), who ran each stage (role, round, model, time, tokens,
 * cost), and over many tasks how each stage and each model on a stage fared. Pure: the server reads the rows (server/report.ts).
 *
 * Tokens and cost are honest: a provider that reports no usage (Cursor, OpenCode often) is `not_measured`, never 0; a writer thread
 * several attempts share carries its tokens on the last of them, the others are `partial`. A code stage (checks, plan against fact,
 * acceptance) runs no model: its row is `code`, with time only.
 */
export const GRAPH_STAGES = [
  "pm-read", "plan-critique", "specialist-review", "run-gate", "writer-agent", "verification", "code-critique", "plan-fact", "browser-qa",
  "acceptance-receipt", "docs-maintenance", "memory-maintenance", "project-life",
] as const;
const REVIEWER_STAGES = new Set(["plan-critique", "specialist-review", "code-critique", "night-review"]);
const CODE_STAGES = new Set(["run-gate", "verification", "plan-fact", "acceptance-receipt", "workspace-status"]);

export type CellState = "passed" | "failed" | "running" | "pending" | "skipped" | "canceled";
export type StageCell = { stageId: string; state: CellState; rounds: number; failures: number; reason: string | null };
export type Role = "writer" | "agent" | "reviewer" | "code";
export type CostState = "measured" | "partial" | "not_measured";
export type Tokens = { fresh: number; cacheRead: number; cacheWrite: number; output: number };
export type ExecutorRow = {
  stageId: string; role: Role; round: number; threadId: string | null; providerId: string | null; model: string | null;
  seconds: number | null; tokens: Tokens | null; costUsd: number | null; costState: CostState | null; turns: number | null;
};
export type StageBlock = { cell: StageCell; rows: ExecutorRow[] };
export type TaskSummary = { returns: number; seconds: number | null; costUsd: number | null; costState: CostState | null; models: string[] };
export type TaskGraph = { cells: StageCell[]; stages: StageBlock[]; summary: TaskSummary };

export type StageEventIn = { stageId: string; state: string; at: number };
export type ReceiptIn = { stageId: string; state: string; threadId: string | null; providerId: string | null; model: string | null; reason: string | null; updatedAt: number };
export type AttemptIn = { id: string; no: number; state: string; threadId: string | null; createdAt: number; updatedAt: number };
export type UsageIn = { providerId: string | null; model: string | null; billed: Tokens | null };
export type PriceFn = (model: string, billed: Tokens) => number | null;

const TERMINAL = new Set(["passed", "failed", "blocked", "skipped", "canceled"]);
const ENDED_ATTEMPT = new Set(["accepted", "succeeded", "failed", "blocked", "canceled", "rejected", "error"]);
const order = (stageId: string) => { const index = (GRAPH_STAGES as readonly string[]).indexOf(stageId); return index < 0 ? GRAPH_STAGES.length : index; };
const cellState = (state: string): CellState => (state === "blocked" ? "failed" : (["passed", "failed", "running", "pending", "skipped", "canceled"] as const).find((value) => value === state) ?? "pending");
export const roleOf = (stageId: string): Role => (stageId === "writer-agent" ? "writer" : REVIEWER_STAGES.has(stageId) ? "reviewer" : CODE_STAGES.has(stageId) ? "code" : "agent");

/** One cell per stage that has an event or a receipt, in the pipeline's order. */
export function stageCells(events: readonly StageEventIn[], receipts: readonly ReceiptIn[]): StageCell[] {
  const ids = [...new Set([...events.map((row) => row.stageId), ...receipts.map((row) => row.stageId)])].sort((a, b) => order(a) - order(b));
  return ids.map((stageId) => {
    const own = events.filter((row) => row.stageId === stageId);
    const receipt = receipts.find((row) => row.stageId === stageId);
    const state = cellState(receipt?.state ?? own.at(-1)?.state ?? "pending");
    // A stage that polls its helper writes «running» again on every poll: a round starts only when it was not running already.
    const started = own.filter((row, index) => row.state === "running" && own[index - 1]?.state !== "running").length;
    const rounds = Math.max(started, state === "passed" || state === "failed" ? 1 : 0);
    return { stageId, state, rounds, failures: own.filter((row) => row.state === "failed" || row.state === "blocked").length, reason: receipt?.reason ?? null };
  });
}

/** Seconds a stage spent from each `running` to the end that followed it; null when it never reported running. */
function stageSeconds(events: readonly StageEventIn[], stageId: string): number | null {
  let from: number | null = null, total = 0, any = false;
  for (const row of events) {
    if (row.stageId !== stageId) continue;
    if (row.state === "running") { from = row.at; continue; }
    if (from !== null && TERMINAL.has(row.state)) { total += Math.max(0, row.at - from); any = true; from = null; }
  }
  return any ? Math.round(total / 1000) : null;
}

function priced(usage: UsageIn | undefined, price: PriceFn): Pick<ExecutorRow, "tokens" | "costUsd" | "costState" | "providerId" | "model"> {
  const providerId = usage?.providerId ?? null, model = usage?.model ?? null;
  const billed = usage?.billed ?? null;
  if (!billed || billed.fresh + billed.cacheRead + billed.cacheWrite + billed.output === 0) return { tokens: null, costUsd: null, costState: "not_measured", providerId, model };
  const cost = model ? price(model, billed) : null;
  return { tokens: billed, costUsd: cost, costState: cost === null ? "partial" : "measured", providerId, model };
}

export function taskGraph(input: {
  events: readonly StageEventIn[]; receipts: readonly ReceiptIn[]; attempts: readonly AttemptIn[];
  usage(threadId: string): UsageIn | undefined; price: PriceFn; turns?(threadId: string): number | null;
}): TaskGraph {
  const cells = stageCells(input.events, input.receipts);
  const writerThreads = new Set(input.attempts.flatMap((row) => (row.threadId ? [row.threadId] : [])));
  const lastOnThread = new Map<string, string>();
  for (const attempt of input.attempts) if (attempt.threadId) lastOnThread.set(attempt.threadId, attempt.id);
  const turns = (threadId: string | null) => (threadId && input.turns ? input.turns(threadId) : null);

  const stages: StageBlock[] = cells.map((cell) => {
    const receipt = input.receipts.find((row) => row.stageId === cell.stageId);
    const role = roleOf(cell.stageId);
    if (role === "writer") {
      const rows = input.attempts.map((attempt): ExecutorRow => {
        const shared = attempt.threadId !== null && lastOnThread.get(attempt.threadId) !== attempt.id;
        const cost = attempt.threadId && !shared ? priced(input.usage(attempt.threadId), input.price)
          : { tokens: null, costUsd: null, costState: attempt.threadId ? "partial" as const : null, providerId: receipt?.providerId ?? null, model: receipt?.model ?? null };
        return {
          stageId: cell.stageId, role, round: attempt.no, threadId: attempt.threadId, ...cost,
          providerId: cost.providerId ?? receipt?.providerId ?? null, model: cost.model ?? receipt?.model ?? null,
          seconds: ENDED_ATTEMPT.has(attempt.state) ? Math.max(0, Math.round((attempt.updatedAt - attempt.createdAt) / 1000)) : null,
          turns: shared ? null : turns(attempt.threadId),
        };
      });
      return { cell, rows };
    }
    if (cell.state === "skipped" && cell.rounds === 0) return { cell, rows: [] };
    const seconds = stageSeconds(input.events, cell.stageId);
    const own = receipt?.threadId && !writerThreads.has(receipt.threadId) ? receipt.threadId : null;
    if (role === "code" || !own) {
      return { cell, rows: [{ stageId: cell.stageId, role: own ? role : "code", round: Math.max(1, cell.rounds), threadId: null, providerId: null, model: null, seconds, tokens: null, costUsd: null, costState: null, turns: null }] };
    }
    const cost = priced(input.usage(own), input.price);
    return { cell, rows: [{ stageId: cell.stageId, role, round: Math.max(1, cell.rounds), threadId: own, ...cost,
      providerId: cost.providerId ?? receipt?.providerId ?? null, model: cost.model ?? receipt?.model ?? null, seconds, turns: turns(own) }] };
  });

  const rows = stages.flatMap((stage) => stage.rows);
  const costed = rows.filter((row) => row.costState !== null);
  const measured = costed.filter((row) => row.costState === "measured");
  const seconds = rows.some((row) => row.seconds !== null) ? rows.reduce((sum, row) => sum + (row.seconds ?? 0), 0) : null;
  return {
    cells, stages,
    summary: {
      returns: cells.reduce((sum, cell) => sum + Math.max(0, cell.rounds - 1), 0),
      seconds,
      costUsd: measured.length ? Math.round(measured.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) * 10_000) / 10_000 : null,
      costState: !costed.length ? null : measured.length === costed.length ? "measured" : measured.length ? "partial" : "not_measured",
      models: [...new Set(rows.flatMap((row) => (row.model ? [row.model] : [])))],
    },
  };
}

/* ---- many tasks: stages and models ---- */

export type StageStat = {
  stageId: string; green: number; red: number; unknown: number; skipped: number; greenShare: number | null;
  medianRounds: number | null; medianCostUsd: number | null; medianSeconds: number | null;
};
export type ModelStageStat = {
  model: string; role: Role; stageId: string; n: number;
  /** Writer and agents: the share of passed; reviewers: the share where they blocked (failed the stage). */
  share: number | null; shareKind: "green" | "blocking"; medianCostUsd: number | null; medianSeconds: number | null;
};
export type GraphStats = { tasks: number; stages: StageStat[]; models: ModelStageStat[] };

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);
const sumOrNull = (values: ReadonlyArray<number | null>) => (values.some((value) => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null);

export function graphStats(graphs: readonly TaskGraph[]): GraphStats {
  const byStage = new Map<string, StageBlock[]>();
  for (const graph of graphs) for (const block of graph.stages) byStage.set(block.cell.stageId, [...(byStage.get(block.cell.stageId) ?? []), block]);
  const stages: StageStat[] = [...byStage].sort(([a], [b]) => order(a) - order(b)).map(([stageId, blocks]) => {
    const green = blocks.filter((block) => block.cell.state === "passed").length, red = blocks.filter((block) => block.cell.state === "failed").length;
    const skipped = blocks.filter((block) => block.cell.state === "skipped").length;
    const ran = blocks.filter((block) => block.cell.rounds > 0);
    return {
      stageId, green, red, skipped, unknown: blocks.length - green - red - skipped, greenShare: share(green, green + red),
      medianRounds: median(ran.map((block) => block.cell.rounds)),
      medianCostUsd: median(ran.flatMap((block) => { const cost = sumOrNull(block.rows.map((row) => row.costUsd)); return cost === null ? [] : [cost]; })),
      medianSeconds: median(ran.flatMap((block) => { const seconds = sumOrNull(block.rows.map((row) => row.seconds)); return seconds === null ? [] : [seconds]; })),
    };
  });
  const byModel = new Map<string, { model: string; role: Role; stageId: string; states: CellState[]; costs: number[]; seconds: number[] }>();
  for (const graph of graphs) for (const block of graph.stages) {
    for (const row of block.rows) {
      if (!row.model) continue;
      const key = `${row.model}\u0000${row.stageId}`;
      const entry = byModel.get(key) ?? { model: row.model, role: row.role, stageId: row.stageId, states: [], costs: [], seconds: [] };
      entry.states.push(block.cell.state);
      if (row.costUsd !== null) entry.costs.push(row.costUsd);
      if (row.seconds !== null) entry.seconds.push(row.seconds);
      byModel.set(key, entry);
    }
  }
  const models: ModelStageStat[] = [...byModel.values()].sort((a, b) => order(a.stageId) - order(b.stageId) || b.states.length - a.states.length).map((entry) => {
    const passed = entry.states.filter((state) => state === "passed").length, failed = entry.states.filter((state) => state === "failed").length;
    const reviewer = entry.role === "reviewer";
    return {
      model: entry.model, role: entry.role, stageId: entry.stageId, n: entry.states.length,
      share: reviewer ? share(failed, passed + failed) : share(passed, passed + failed), shareKind: reviewer ? "blocking" : "green",
      medianCostUsd: median(entry.costs), medianSeconds: median(entry.seconds),
    };
  });
  return { tasks: graphs.length, stages, models };
}
