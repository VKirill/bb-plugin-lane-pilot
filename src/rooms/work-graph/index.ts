// Public API of work-graph: the pure graph of a task and the stage × model statistics (the server part reads the rows behind ./server).
export { GRAPH_STAGES, graphStats, median, roleOf, stageCells, taskGraph, ceilingLine } from "./logic";
export type { AttemptIn, CellState, CostState, ExecutorRow, GraphStats, ModelStageStat, ReceiptIn, Role, StageBlock, StageCell, StageEventIn, StageStat, TaskGraph, TaskSummary, Tokens, UsageIn } from "./logic";
export { tailWords } from "./log-tail";
