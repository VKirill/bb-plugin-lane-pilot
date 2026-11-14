/**
 * Which of a phase's turns waits for the owner's word, decided per turn from that turn's own evidence (owner.words; default-path audit
 * 2026-11-14 §5.4). Until 0.1.560 the phase decided once, at opening, from its title and goal, and every turn read that one flag: on
 * `sensitive` a neutral goal whose plan adds a migration asked nothing, and a goal that says «оплата» asked at all eight turns. The owner's
 * rule (2026-11-14): no task waits for a person except money, database migrations and production deploys.
 *
 * Each turn's evidence:
 *   context                       the phase's title and goal;
 *   planning, issue, lesson       every plan piece's contract (owns_paths, verification commands, title / objective), each piece on its own;
 *   wave n                        the pieces of wave n;
 *   design                        the drawing's paths;
 *   uat, acceptance               the files the phase's pieces changed (their merged attempts), else their owns_paths.
 * On `on` and `risky` every turn asks (as before), on `off` none, on `sensitive` a turn asks when its evidence is in the three classes.
 * The decisions are kept in `record.wordTurns` (the driver recomputes them on every step, on a plan, a plan check, a drawing and a word);
 * a record from before carries only `ownerWords` and reads it until its first step recomputes it.
 */
import { ownerWordsMode, sensitiveHits, taskStepEvidence, type OwnerWordsMode, type SensitiveClass, type SensitiveHit } from "../../tasks";
import type { Phase, PhaseRecord, PhaseStage, PlanItem, WordTurn } from "./record";

export type TurnDecision = { asks: boolean; classes: SensitiveClass[]; evidence: string[] };
/** The turns other than `wave`, which is decided per wave under `waves`. */
export type SingleWordTurn = Exclude<WordTurn, "wave">;
export type WordTurns = { mode: OwnerWordsMode; at: number; waves?: Record<string, TurnDecision> } & Partial<Record<SingleWordTurn, TurnDecision>>;

const SINGLE_TURNS: readonly SingleWordTurn[] = ["context", "planning", "design", "issue", "acceptance", "uat", "lesson"];
const CLASS_TEXT: Record<SensitiveClass, string> = { money: "money", data: "a database migration or data change", deploy: "a production deploy" };

function decide(mode: OwnerWordsMode, hits: readonly SensitiveHit[]): TurnDecision {
  const classes = [...new Set(hits.map((hit) => hit.cls))];
  return { asks: mode === "on" || mode === "risky" || (mode === "sensitive" && classes.length > 0), classes, evidence: hits.map((hit) => hit.evidence).slice(0, 6) };
}

/** The hits of some pieces, each piece weighed on its own (a docs piece's words do not count against a code piece's paths). */
function pieceHits(items: readonly PlanItem[], changed?: ReadonlyMap<string, readonly string[]>): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  for (const item of items) {
    for (const hit of sensitiveHits(taskStepEvidence(item.task as never, changed?.get(item.id)))) {
      if (!hits.some((seen) => seen.cls === hit.cls)) hits.push({ cls: hit.cls, evidence: `${item.id}: ${hit.evidence}` });
    }
  }
  return hits;
}

/**
 * Every turn's decision now. `settings` are the project's effective settings (owner.words); `changed` the files each piece's merged work
 * changed, by piece id, when known.
 */
export function wordTurnsOf(phase: Pick<Phase, "title" | "goal" | "record">, settings: Readonly<Record<string, unknown>>, at: number, changed?: ReadonlyMap<string, readonly string[]>): WordTurns {
  const mode = ownerWordsMode(settings);
  const r = phase.record;
  const items = r.plan?.items ?? [];
  const planned = pieceHits(items);
  const waves: Record<string, TurnDecision> = {};
  for (const wave of [...new Set(items.map((item) => item.wave))].sort((a, b) => a - b)) waves[String(wave)] = decide(mode, pieceHits(items.filter((item) => item.wave === wave)));
  const landed = decide(mode, pieceHits(items, changed));
  return {
    mode, at,
    context: decide(mode, sensitiveHits({ text: [phase.title, phase.goal] })),
    planning: decide(mode, planned),
    issue: decide(mode, planned),
    lesson: decide(mode, planned),
    design: decide(mode, sensitiveHits({ paths: r.design?.drawing?.paths ?? [] })),
    uat: landed,
    acceptance: landed,
    ...(Object.keys(waves).length ? { waves } : {}),
  };
}

const sameTurns = (a: WordTurns | undefined, b: WordTurns): boolean => {
  if (!a) return false;
  const { at: _a, ...left } = a;
  const { at: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
};

/** The record with its turns decided now, or null when they are what the record already holds (nothing to save). */
export function refreshedWordTurns(phase: Pick<Phase, "title" | "goal" | "record">, settings: Readonly<Record<string, unknown>>, at: number, changed?: ReadonlyMap<string, readonly string[]>): PhaseRecord | null {
  const turns = wordTurnsOf(phase, settings, at, changed);
  // The landing turns are known from merged work only on the step that reads it: a call without `changed` keeps what that step found.
  const keep = !changed && phase.record.wordTurns ? { uat: phase.record.wordTurns.uat ?? turns.uat, acceptance: phase.record.wordTurns.acceptance ?? turns.acceptance } : {};
  const next: WordTurns = { ...turns, ...keep };
  if (sameTurns(phase.record.wordTurns, next)) return null;
  // `ownerWords` stays the one-line answer older readers know: does any turn of this phase ask.
  return { ...phase.record, wordTurns: next, ownerWords: anyTurnAsks({ ...phase.record, wordTurns: next }) };
}

/**
 * Does this turn wait for the owner's word. A record whose turns were decided reads its turn; a wave not decided yet reads the mode
 * (every wave asks on `on` / `risky`, none on `sensitive` without evidence); a record from before reads its one flag.
 */
export function wordAsked(record: PhaseRecord, turn: WordTurn, wave?: number): boolean {
  const turns = record.wordTurns;
  if (!turns) return !!record.ownerWords;
  const decided = turn === "wave" ? turns.waves?.[String(wave)] : turns[turn];
  return decided ? decided.asks : turns.mode === "on" || turns.mode === "risky";
}

/** Does any turn of the phase wait for the owner's word (the phase screen's «asked» and the analysis's gray-area questions). */
export function anyTurnAsks(record: PhaseRecord): boolean {
  const turns = record.wordTurns;
  if (!turns) return !!record.ownerWords;
  return SINGLE_TURNS.some((turn) => turns[turn]?.asks) || Object.values(turns.waves ?? {}).some((wave) => wave.asks);
}

/** The turn whose evidence a stage's questions are weighed by (verification weighs the landed work like acceptance; a closed phase none). */
export function stageTurn(stage: PhaseStage): SingleWordTurn | null {
  return stage === "discussion" ? "context" : stage === "planning" ? "planning" : stage === "design" ? "design" : stage === "execution" ? "issue"
    : stage === "verification" || stage === "acceptance" ? "acceptance" : stage === "lessons" ? "lesson" : null;
}

/** Why the turn waits, for the gap texts: the class its evidence is in on `sensitive`, the mode otherwise. */
export function wordReason(record: PhaseRecord, turn: WordTurn, wave?: number): string {
  const turns = record.wordTurns;
  const decided = !turns ? undefined : turn === "wave" ? turns.waves?.[String(wave)] : turns[turn];
  if (turns?.mode === "sensitive" && decided?.classes.length) {
    const first = decided.evidence[0] ? ` (${decided.evidence[0]})` : "";
    return `it touches ${decided.classes.map((cls) => CLASS_TEXT[cls]).join(" and ")}${first}`;
  }
  return turns ? `owner.words is ${turns.mode}` : "owner.words was on when the phase opened";
}
