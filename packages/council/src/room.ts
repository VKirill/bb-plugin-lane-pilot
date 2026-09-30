import { parseAgenda, parseDecisionRecord, type CouncilMessage, type CouncilMessageKind, type CouncilSeat, type CouncilSession, type DecisionRecord } from "./contract";
import { moderate, roundNovelty, type Moderator } from "./moderator";
import { agendaPrompt, chairPrompt, seatPrompt } from "./prompts";
import { CHAIR_SEAT_ID, MODERATOR_SEAT_ID, type CouncilIo } from "./run";

/** Why a seat wants the floor, strongest first. */
export type ImpulseReason = "addressed" | "disagreement" | "evidence" | "turn" | "none";
export type Impulse = { seatId: string; score: number; reason: ImpulseReason };

/** An outside judge (Jev) asked, per seat, whether it has something to add to the last message; null means "no opinion". */
export type ImpulseJudge = (input: { session: CouncilSession; seat: CouncilSeat; last: CouncilMessage; ownStatements: readonly CouncilMessage[] }) => Promise<Impulse | null>;

export const IMPULSE_SCORES: Record<ImpulseReason, number> = { addressed: 1, disagreement: 0.85, evidence: 0.75, turn: 0.6, none: 0.1 };
export const FLOOR_THRESHOLD = 0.5;

function mentions(text: string, seat: CouncilSeat): boolean {
  const haystack = text.toLowerCase();
  return [seat.title, seat.role, seat.id, ...(seat.aliases ?? [])].some((name) => name && haystack.includes(name.toLowerCase()));
}

/**
 * The rule that stands in for the judge: a seat that is addressed must speak; after the owner speaks
 * everyone considers it; a seat that has been quiet for a full lap gets the floor; the last speaker waits.
 */
export function ruleImpulse(input: { session: CouncilSession; seat: CouncilSeat; feed: readonly CouncilMessage[]; last: CouncilMessage }): Impulse {
  const { seat, feed, last, session } = input;
  if (last.seatId === seat.id) return { seatId: seat.id, score: 0, reason: "none" };
  let ownLast = -1;
  for (let i = feed.length - 1; i >= 0; i -= 1) if (feed[i]!.seatId === seat.id) { ownLast = i; break; }
  const sinceOwn = feed.slice(ownLast + 1).filter((message) => message.seatId !== MODERATOR_SEAT_ID);
  if (sinceOwn.some((message) => mentions(message.text, seat))) return { seatId: seat.id, score: IMPULSE_SCORES.addressed, reason: "addressed" };
  if (last.kind === "owner") return { seatId: seat.id, score: 0.8, reason: "evidence" };
  const seatIds = new Set(session.seats.map((item) => item.id));
  const spoken = feed.filter((message) => seatIds.has(message.seatId));
  const recent = spoken.slice(-session.seats.length);
  if (!recent.some((message) => message.seatId === seat.id)) return { seatId: seat.id, score: IMPULSE_SCORES.turn, reason: "turn" };
  return { seatId: seat.id, score: IMPULSE_SCORES.none, reason: "none" };
}

/** The seat with the strongest impulse above the floor threshold; ties go to the seat that spoke least recently. */
export function chooseSpeaker(impulses: readonly Impulse[], feed: readonly CouncilMessage[], threshold = FLOOR_THRESHOLD): Impulse | null {
  const lastSpokeAt = (seatId: string) => { for (let i = feed.length - 1; i >= 0; i -= 1) if (feed[i]!.seatId === seatId) return i; return -1; };
  const eligible = impulses.filter((impulse) => impulse.score >= threshold);
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => b.score - a.score || lastSpokeAt(a.seatId) - lastSpokeAt(b.seatId))[0]!;
}

export type RoomIo = CouncilIo & {
  impulse?: ImpulseJudge;
  /** New owner messages stored since `afterSeq`; the room merges them into its feed. */
  pollOwner: (afterSeq: number) => CouncilMessage[];
  /** Waits for the owner to say something (or ask to decide); resolves null on timeout or stop. */
  waitForOwner: (afterSeq: number) => Promise<CouncilMessage | null>;
  decideRequested: () => boolean;
  presence?: (seatId: string | null) => void;
  maxTurns?: number;
};

const PASS = /^\s*PASS\.?\s*$/i;

/**
 * The boardroom: after the agenda, seats speak when they want to, not in turn. After every message the
 * seats' impulse is judged, one gets the floor, the moderator decides whether the room still adds anything,
 * and the owner may speak at any time; an addressed seat answers next. The chair decides at the end.
 */
export async function runRoom(initial: CouncilSession, io: RoomIo): Promise<DecisionRecord | null> {
  let session = initial;
  const feed: CouncilMessage[] = [];
  const lastSeen = new Map<string, number>();
  const maxTurns = io.maxTurns ?? session.maxRounds * session.seats.length;
  let seen = 0;
  const note = (seatId: string, round: number, kind: CouncilMessageKind, text: string) => {
    const saved = io.save.message({ seatId, round, kind, text });
    feed.push(saved);
    seen = Math.max(seen, saved.seq);
    return saved;
  };
  const absorbOwner = () => {
    const fresh = io.pollOwner(seen);
    for (const message of fresh) { feed.push(message); seen = Math.max(seen, message.seq); }
    return fresh.length > 0;
  };
  const stopped = () => {
    if (!io.isStopped()) return false;
    io.save.state({ state: "stopped", reason: "stopped by the owner" });
    return true;
  };
  try {
    const evidence = await io.evidence();
    absorbOwner();
    if (stopped()) return null;
    const agenda = parseAgenda(await io.spawnTurn({ session, seat: null, round: 0, prompt: agendaPrompt({ session, evidence, workspace: io.workspace }) }));
    io.save.agenda(agenda.agenda, agenda.criteria);
    session = { ...session, agenda: agenda.agenda, criteria: agenda.criteria };
    note(CHAIR_SEAT_ID, 0, "agenda", `Agenda:\n${agenda.agenda.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nCriteria: ${agenda.criteria.join("; ")}`);
    io.save.state({ state: "discussion", round: 1 });

    // Opening lap: every seat states its position once, so the room has something to react to.
    for (const seat of session.seats) {
      if (stopped()) return null;
      absorbOwner();
      io.presence?.(seat.id);
      const text = (await io.spawnTurn({ session, seat, round: 1, prompt: seatPrompt({ session, seat, round: 1, evidence, feed, sinceSeq: 0, workspace: io.workspace }) })).trim();
      io.presence?.(null);
      const saved = note(seat.id, 1, "position", text);
      lastSeen.set(seat.id, saved.seq);
    }

    let turns = session.seats.length;
    let lap = 2;
    let earlier: string[] = feed.filter((message) => message.kind === "position").map((message) => message.text);
    let sinceModerator: string[] = [];
    while (turns < maxTurns) {
      if (stopped()) return null;
      absorbOwner();
      if (io.decideRequested()) { note(MODERATOR_SEAT_ID, lap, "status", "The owner asked for the decision."); break; }
      const last = feed.at(-1)!;
      const impulses: Impulse[] = [];
      const judgedBy = new Map<string, "judge" | "rule">();
      for (const seat of session.seats) {
        const own = feed.filter((message) => message.seatId === seat.id);
        let impulse: Impulse | null = null;
        if (io.impulse) { try { impulse = await io.impulse({ session, seat, last, ownStatements: own }); } catch { impulse = null; } }
        judgedBy.set(seat.id, impulse ? "judge" : "rule");
        impulses.push(impulse ?? ruleImpulse({ session, seat, feed, last }));
      }
      const speaker = chooseSpeaker(impulses, feed);
      if (!speaker) {
        note(MODERATOR_SEAT_ID, lap, "status", "Nobody asked for the floor; waiting for the owner.");
        const owner = await io.waitForOwner(seen);
        if (!owner) { note(MODERATOR_SEAT_ID, lap, "status", "The owner did not add anything; time to decide."); break; }
        absorbOwner();
        continue;
      }
      const seat = session.seats.find((item) => item.id === speaker.seatId)!;
      note(MODERATOR_SEAT_ID, lap, "status", `Floor: ${seat.title} (${speaker.reason}, ${judgedBy.get(seat.id) ?? "rule"}; ${impulses.map((item) => `${item.seatId} ${Math.round(item.score * 100)}%`).join(", ")})`);
      io.presence?.(seat.id);
      const text = (await io.spawnTurn({ session, seat, round: lap, prompt: seatPrompt({ session, seat, round: lap, evidence, feed, sinceSeq: lastSeen.get(seat.id) ?? 0, workspace: io.workspace }) })).trim();
      io.presence?.(null);
      turns += 1;
      lastSeen.set(seat.id, feed.at(-1)?.seq ?? 0);
      if (PASS.test(text)) { note(seat.id, lap, "status", `PASS (${speaker.reason})`); continue; }
      const saved = note(seat.id, lap, "reply", text);
      lastSeen.set(seat.id, saved.seq);
      sinceModerator.push(text);
      if (sinceModerator.length >= session.seats.length) {
        const novelty = roundNovelty(earlier, sinceModerator);
        const verdict = await moderate({ round: lap, maxRounds: session.maxRounds, novelty, passed: 0, seats: session.seats.length }, io.moderator);
        note(MODERATOR_SEAT_ID, lap, "status", `${verdict.verdict === "continue" ? "The room still adds something" : "Time to decide"} (${verdict.by}; novelty ${Math.round(novelty * 100)}%)`);
        earlier = [...earlier, ...sinceModerator];
        sinceModerator = [];
        lap += 1;
        io.save.state({ round: lap });
        if (verdict.verdict === "synthesize") {
          const owner = await io.waitForOwner(seen);
          if (!owner) break;
          absorbOwner();
        }
      }
    }
    if (stopped()) return null;
    io.save.state({ state: "synthesis" });
    io.presence?.(CHAIR_SEAT_ID);
    const decision = parseDecisionRecord(await io.spawnTurn({ session, seat: null, round: lap, prompt: chairPrompt({ session, evidence, feed, workspace: io.workspace }) }));
    io.presence?.(null);
    note(CHAIR_SEAT_ID, lap, "decision", decision.recommendation);
    io.save.state({ state: "done", decision, reason: null });
    return decision;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    io.presence?.(null);
    io.log?.(`council ${session.id} failed: ${reason}`);
    io.save.state({ state: "failed", reason });
    note(MODERATOR_SEAT_ID, session.round, "status", `Failed: ${reason}`);
    return null;
  }
}
