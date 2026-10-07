import type { SimResult } from "./chain-harness";

/** Small helpers shared by the chain test cases (chains-*.test.ts). */
export type Row = Record<string, unknown>;
/** The nodes that ran or were skipped, in order, as the spec's `expect_path` lists them. */
export const pathOf = (result: SimResult) => result.path.join(" ");
export const out = (result: SimResult) => result.summary.output;
export const task = (id: string, extra: Row = {}) => ({ id, objective: id, depends_on: [], ...extra });
export const goals = [{ id: "g1", done_when: "flag works", evidence: "npm test" }];
export const finding = (severity: string, extra: Row = {}) => ({ file: "src/a.ts", line: 12, severity, evidence: "return value of save() ignored", dimension: "correctness", ...extra });
/** The results of lp.build's tasks, one per call in order; the last repeats. Make a new one per run: it counts. */
export const taskResults = (...states: Row[]) => { let at = -1; return (() => { at += 1; return states[Math.min(at, states.length - 1)]!; }) as never; };
export const accepted = (commit: string): Row => ({ state: "accepted", merge_commit: commit });
export const modeOf = (result: SimResult) => (result.db.prepare("SELECT mode FROM lane_pilot_wf_run WHERE id=?").get(result.summary.runId) as { mode: string }).mode;
/** What a stubbed node was last given as `with` (the data of its edge and its own `with`). */
export const firstInput = (result: SimResult, node: string) => result.called(node)[0]!.input;
