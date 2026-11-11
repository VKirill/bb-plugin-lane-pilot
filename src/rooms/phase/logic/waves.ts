import { sha256Hex } from "@lane-pilot/kit";
import { NO_CODE_KINDS } from "../../tasks";
import { buildsScreens } from "../stages";
import { gate, type GateResult } from "./gates";
import type { PhaseRecord, PlanItem, WaveRecord } from "./record";
import { canonical } from "./signatures";

export type TaskFact = { taskId: string; attemptId?: string | null; state: string | null; planFact: "passed" | "failed" | "skipped" | null; verification: "passed" | "failed" | "skipped" | null; codeCritique: "passed" | "blocked" | "skipped" | "failed" | null; browserQa?: "passed" | "failed" | "skipped" | null; qaPlanned?: boolean };

/** The pieces that may be issued now: wave by wave, the next wave only once every piece of the earlier waves is accepted. */
/** What a piece's work is: its contract and its promise. A changed one after a return to planning is new work. */
export const pieceSha = (item: PlanItem) => sha256Hex(canonical({ task: item.task, promise: item.promise }));

export function issuable(items: readonly PlanItem[], issued: Readonly<Record<string, string>>, facts: ReadonlyMap<string, TaskFact>, cleared: (wave: number) => boolean = () => true,
  issuedSha: Readonly<Record<string, string>> = {}): PlanItem[] {
  for (const wave of wavesOf(items)) {
    const pieces = piecesOfWave(items, wave);
    // The head changed (SMA: the train runs again on a new head from the stage that changed, skipping the stages that did not):
    // a piece whose contract changed since it was issued is issued again; an unchanged one keeps its work.
    const waiting = pieces.filter((item) => !issued[item.id] || (issuedSha[item.id] !== undefined && issuedSha[item.id] !== pieceSha(item)));
    if (waiting.length) return waiting;
    if (!pieces.every((item) => facts.get(item.id)?.state === "accepted")) return [];
    if (!cleared(wave)) return [];
  }
  return [];
}

/** The pieces of one wave. */
export const piecesOfWave = (items: readonly PlanItem[], wave: number) => items.filter((item) => item.wave === wave);
export const wavesOf = (items: readonly PlanItem[]) => [...new Set(items.map((item) => item.wave))].sort((a, b) => a - b);

/** The wave's package: its pieces, their tasks and states, hashed — the same wave has the same package. */
export const wavePackage = (pieces: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>) =>
  sha256Hex(canonical(pieces.map((item) => [item.id, facts.get(item.id)?.taskId ?? null, facts.get(item.id)?.state ?? null, facts.get(item.id)?.planFact ?? null])));

/** The ids of the acceptance lines a piece is held to: the same set the wave folds and the phase acceptance reads (SMA bw_lines). */
export const PIECE_LINE_IDS = ["contract_current", "landed", "promises_proved", "checks_passed", "independent_check", "qa_read"] as const;
export type PieceLineId = (typeof PIECE_LINE_IDS)[number];

/** One piece's acceptance lines, judged by the same rules the phase acceptance uses. `issuedSha` is the contract print it was
 *  issued with; left out it is taken as current (a piece not issued yet is judged on the plan's contract). */
export function pieceLines(item: PlanItem, fact: TaskFact | undefined, issuedSha?: string, liveCheckPossible = false): Array<{ id: PieceLineId; ok: boolean; detail: string }> {
  const current = issuedSha === undefined || issuedSha === pieceSha(item);
  const proved = fact?.planFact === "passed" || (fact?.planFact === "skipped" && !needsPlanFact(item));
  const checks = fact?.verification !== "failed";
  const critiqued = fact?.codeCritique === "passed";
  // SMA k_we_verify: visible work needs a passed browser check whether or not it planned qa_cases — unless the project has
  // browser check switched on (browser_qa.enabled): elsewhere the line holds and says «no live check owed».
  const qa = fact?.browserQa !== "failed" && !(fact?.qaPlanned && fact.browserQa !== "passed") && !(buildsScreens(item) && liveCheckPossible && fact?.browserQa !== "passed");
  return [
    { id: "contract_current", ok: current, detail: current ? "the issued contract is the plan's" : "its contract changed after issue" },
    { id: "landed", ok: fact?.state === "accepted", detail: fact?.state === "accepted" ? "merged" : `is ${fact?.state ?? "not issued"}` },
    { id: "promises_proved", ok: proved, detail: proved ? "plan-fact proved the promise" : `plan-fact ${fact?.planFact ?? "left no receipt"}` },
    { id: "checks_passed", ok: checks, detail: checks ? "its checks pass" : "its checks failed" },
    { id: "independent_check", ok: critiqued, detail: critiqued ? "the code critic passed it" : `the code critic ${fact?.codeCritique === "blocked" ? "blocks it" : "has not passed it (no critic receipt is no reading)"}` },
    { id: "qa_read", ok: qa, detail: qa ? (fact?.browserQa === "passed" ? "the browser check passed" : buildsScreens(item) && !liveCheckPossible ? "visible work, no live check owed (browser_qa off or no browser machine named)" : "no browser check planned (no qa_cases)")
      : buildsScreens(item) && !fact?.qaPlanned ? `visible work, the browser check ${fact?.browserQa === "failed" ? "failed" : "has not passed"}` : `the browser check ${fact?.browserQa === "failed" ? "failed" : "has not passed"}` },
  ];
}

/** The wave's acceptance lines: one and the same set for the wave and for each of its pieces (SMA bw_lines) — a line holds only
 *  when every piece's line holds, and it names the pieces that fail it. */
export function waveLines(pieces: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>, issuedSha: Readonly<Record<string, string>> = {}, liveCheckPossible = false): WaveRecord["lines"] {
  const per = pieces.map((item) => ({ item, lines: pieceLines(item, facts.get(item.id), issuedSha[item.id], liveCheckPossible) }));
  return PIECE_LINE_IDS.map((id) => {
    const failing = per.filter(({ lines }) => !lines.find((line) => line.id === id)!.ok).map(({ item }) => item.id);
    return { id, ok: failing.length === 0, detail: failing.length ? `${id} fails: ${failing.join(", ")}` : `${pieces.length} piece(s) hold ${id}` };
  });
}

/** Each piece's own lines of a wave, kept in its record (SMA bw_lines). */
export const wavePieceLines = (pieces: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>, issuedSha: Readonly<Record<string, string>> = {}, liveCheckPossible = false): Record<string, WaveRecord["lines"]> =>
  Object.fromEntries(pieces.map((item) => [item.id, pieceLines(item, facts.get(item.id), issuedSha[item.id], liveCheckPossible)]));

/** Is a finished wave cleared for the next one: its lines hold, another model verified it (when asked), the owner said yes (when asked). */
export function waveCleared(record: PhaseRecord, wave: number): boolean {
  const done = record.execution?.waves?.[String(wave)];
  if (!done || !done.lines.every((line) => line.ok)) return false;
  if (record.waveReview && done.review?.state !== "passed") return false;
  if (record.ownerWords && ![...(record.words ?? [])].reverse().find((word) => word.turn === "wave" && word.wave === wave && word.decision === "yes")) return false;
  return true;
}

/** Execution → verification: every piece issued and accepted; a blocked piece is reported, not skipped. */
export function executionGate(items: readonly PlanItem[], issued: Readonly<Record<string, string>>, facts: ReadonlyMap<string, TaskFact>): GateResult {
  const why: string[] = [];
  for (const item of items) {
    if (!issued[item.id]) { why.push(`${item.id} is not issued yet`); continue; }
    const state = facts.get(item.id)?.state ?? "queued";
    if (state !== "accepted") why.push(`${item.id} is ${state}`);
  }
  return gate(why);
}

const listOf = (value: unknown) => (Array.isArray(value) ? value : []);
/** A piece that makes acceptance promises about code must show plan-fact for them: a skipped stage proves nothing. */
export const needsPlanFact = (item: PlanItem) => listOf(item.task?.acceptance).length > 0 && !NO_CODE_KINDS.has(String(item.task?.kind ?? ""));
/** A piece with verification commands must show the checks ran: skipped means they did not. */
export const needsChecks = (item: PlanItem) => listOf(item.task?.verification).length > 0;

/** The run's goal check is still at work: the verdict waits for it, it neither passes nor fails. */
export const runGoalPending = (runGoal: { state: string } | null) => runGoal?.state === "running";
