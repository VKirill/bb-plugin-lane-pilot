import type { CouncilMessage, CouncilSeat, CouncilSession } from "./contract";
import { MODERATOR_SEAT_ID } from "./step";

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
