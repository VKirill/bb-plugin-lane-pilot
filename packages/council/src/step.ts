import type { CouncilMessage, CouncilSeat, CouncilSession } from "./contract";

/**
 * What the council graph (workflows/council.json) decides from the feed alone. Every function reads the stored session and its messages and nothing
 * else, so a run that a plugin reload cut off is resumed from the database: no loop state lives in memory.
 */
export const CHAIR_SEAT_ID = "chair";
export const MODERATOR_SEAT_ID = "moderator";
/** The note a request for the decision leaves in the feed; the next `council.next` step finds it there (it survives a reload). */
export const DECIDE_REQUEST_TEXT = "The owner asked for the decision.";

const PASS_NOTE = /^PASS\b/;
/** The moderator's own words after a round (rounds mode) or a lap (room mode); the verdict is read back from them. */
const VERDICT_CONTINUE = /^(Another round|The room still adds something)/;
const VERDICT_SYNTHESIZE = /^Time to decide \(/;

const seatIdsOf = (session: Pick<CouncilSession, "seats">) => new Set(session.seats.map((seat) => seat.id));
const isSaid = (message: CouncilMessage) => message.kind === "position" || message.kind === "reply";
/** A turn a seat took: what it said, or its PASS. */
const isTurn = (message: CouncilMessage, ids: ReadonlySet<string>) => ids.has(message.seatId) && (isSaid(message) || (message.kind === "status" && PASS_NOTE.test(message.text)));

export const decideRequestedIn = (feed: readonly CouncilMessage[]): boolean => feed.some((message) => message.seatId === MODERATOR_SEAT_ID && message.kind === "status" && message.text === DECIDE_REQUEST_TEXT);
export const lastSeqOf = (feed: readonly CouncilMessage[]): number => feed.reduce((top, message) => Math.max(top, message.seq), 0);

/** The verdict the moderator already wrote for `round`, or null when it has not. */
export function verdictWritten(feed: readonly CouncilMessage[], round: number): "continue" | "synthesize" | null {
  for (const message of feed) {
    if (message.seatId !== MODERATOR_SEAT_ID || message.kind !== "status" || message.round !== round) continue;
    if (VERDICT_SYNTHESIZE.test(message.text)) return "synthesize";
    if (VERDICT_CONTINUE.test(message.text)) return "continue";
  }
  return null;
}

/** The last message of a seat in the feed: what its next prompt is shown after (0 for a seat that has not spoken). */
export function seenBySeat(feed: readonly CouncilMessage[], seatId: string): number {
  let seen = 0;
  for (const message of feed) if (message.seatId === seatId) seen = Math.max(seen, message.seq);
  return seen;
}

export type RoundsPlan = {
  round: number;
  /** The next seat to speak in this round; null when every seat has taken its turn. */
  seat: CouncilSeat | null;
  passed: number;
  said: string[];
  earlier: string[];
};

/** Fixed rounds: the current round is the stored `round` (at least 1); a seat is due until it has a message in it. */
export function roundsPlan(session: CouncilSession, feed: readonly CouncilMessage[]): RoundsPlan {
  const ids = seatIdsOf(session);
  const round = Math.max(1, session.round);
  const turns = feed.filter((message) => isTurn(message, ids));
  const inRound = turns.filter((message) => message.round === round);
  return {
    round,
    seat: session.seats.find((seat) => !inRound.some((message) => message.seatId === seat.id)) ?? null,
    passed: inRound.filter((message) => message.kind === "status").length,
    said: inRound.filter(isSaid).map((message) => message.text),
    earlier: turns.filter((message) => isSaid(message) && message.round < round).map((message) => message.text),
  };
}

export type RoomPlan = {
  /** The seat that still owes its opening position; null once every seat has stated one. */
  opening: CouncilSeat | null;
  /** Turns taken so far, opening positions and PASSes included. */
  turns: number;
  /** The lap the room is in: replies carry it, and it grows by one after each moderator verdict. */
  lap: number;
  /** The replies of this lap, which the moderator has not weighed yet. */
  replies: CouncilMessage[];
  earlier: string[];
};

/** The boardroom: an opening lap of positions, then replies on impulse; a lap ends when as many seats have replied as there are seats. */
export function roomPlan(session: CouncilSession, feed: readonly CouncilMessage[]): RoomPlan {
  const ids = seatIdsOf(session);
  const turns = feed.filter((message) => isTurn(message, ids));
  const lap = Math.max(2, session.round);
  return {
    opening: session.seats.find((seat) => !turns.some((message) => message.seatId === seat.id && message.kind === "position")) ?? null,
    turns: turns.length,
    lap,
    replies: turns.filter((message) => message.kind === "reply" && message.round === lap),
    earlier: turns.filter((message) => isSaid(message) && message.round < lap).map((message) => message.text),
  };
}

/** The most turns a room takes: rounds times seats, never more than the graph's visit bound (50 visits of `speak`) allows for. */
export const ROOM_TURN_CAP = 48;
export const maxTurnsOf = (session: Pick<CouncilSession, "maxRounds" | "seats">): number => Math.min(ROOM_TURN_CAP, session.maxRounds * session.seats.length);
