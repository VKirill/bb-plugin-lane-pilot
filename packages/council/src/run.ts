import { parseAgenda, parseDecisionRecord, type CouncilMessage, type CouncilMessageKind, type CouncilSeat, type CouncilSession, type DecisionRecord } from "./contract";
import { moderate, roundNovelty, type Moderator } from "./moderator";
import { agendaPrompt, chairPrompt, seatPrompt } from "./prompts";

/** What the host must provide: a way to run one bounded turn of a seat and to persist the feed. */
export type CouncilIo = {
  /** Runs one turn for a seat (or the chair when `seat` is null) and returns the final text. */
  spawnTurn: (input: { session: CouncilSession; seat: CouncilSeat | null; round: number; prompt: string }) => Promise<string>;
  evidence: () => Promise<string>;
  save: {
    agenda: (agenda: string[], criteria: string[]) => void;
    message: (message: Omit<CouncilMessage, "seq" | "councilId" | "at">) => CouncilMessage;
    state: (patch: { state?: CouncilSession["state"]; round?: number; decision?: DecisionRecord | null; reason?: string | null }) => void;
  };
  isStopped: () => boolean;
  moderator?: Moderator;
  log?: (message: string) => void;
};

export const CHAIR_SEAT_ID = "chair";
export const MODERATOR_SEAT_ID = "moderator";

const PASS = /^\s*PASS\.?\s*$/i;

/**
 * The whole protocol: agenda, rounds of positions and replies, a moderator verdict after each round,
 * the chair's decision record. Returns the decision, or null when stopped or failed; the reason is
 * saved on the session either way.
 */
export async function runCouncil(initial: CouncilSession, io: CouncilIo): Promise<DecisionRecord | null> {
  let session = initial;
  const feed: CouncilMessage[] = [];
  const lastSeen = new Map<string, number>();
  const note = (seatId: string, round: number, kind: CouncilMessageKind, text: string) => {
    const saved = io.save.message({ seatId, round, kind, text });
    feed.push(saved);
    return saved;
  };
  const stopped = () => {
    if (!io.isStopped()) return false;
    io.save.state({ state: "stopped", reason: "stopped by the owner" });
    return true;
  };
  try {
    const evidence = await io.evidence();
    if (stopped()) return null;
    const agendaRaw = await io.spawnTurn({ session, seat: null, round: 0, prompt: agendaPrompt({ session, evidence }) });
    const agenda = parseAgenda(agendaRaw);
    io.save.agenda(agenda.agenda, agenda.criteria);
    session = { ...session, agenda: agenda.agenda, criteria: agenda.criteria };
    note(CHAIR_SEAT_ID, 0, "agenda", `Agenda:\n${agenda.agenda.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nCriteria: ${agenda.criteria.join("; ")}`);
    io.save.state({ state: "discussion", round: 0 });

    let earlier: string[] = [];
    for (let round = 1; round <= session.maxRounds; round += 1) {
      if (stopped()) return null;
      io.save.state({ round });
      const said: string[] = [];
      let passed = 0;
      for (const seat of session.seats) {
        if (stopped()) return null;
        const since = lastSeen.get(seat.id) ?? 0;
        const prompt = seatPrompt({ session, seat, round, evidence, feed, sinceSeq: since });
        const text = (await io.spawnTurn({ session, seat, round, prompt })).trim();
        lastSeen.set(seat.id, feed.at(-1)?.seq ?? 0);
        if (round > 1 && PASS.test(text)) { passed += 1; note(seat.id, round, "status", "PASS"); continue; }
        said.push(text);
        const saved = note(seat.id, round, round === 1 ? "position" : "reply", text);
        lastSeen.set(seat.id, saved.seq);
      }
      const novelty = round === 1 ? 1 : roundNovelty(earlier, said);
      earlier = [...earlier, ...said];
      const verdict = await moderate({ round, maxRounds: session.maxRounds, novelty, passed, seats: session.seats.length }, io.moderator);
      note(MODERATOR_SEAT_ID, round, "status", `${verdict.verdict === "continue" ? "Another round" : "Time to decide"} (${verdict.by}; novelty ${Math.round(novelty * 100)}%, passed ${passed}/${session.seats.length})`);
      if (verdict.verdict === "synthesize") break;
    }
    if (stopped()) return null;
    io.save.state({ state: "synthesis" });
    const decisionRaw = await io.spawnTurn({ session, seat: null, round: session.maxRounds + 1, prompt: chairPrompt({ session, evidence, feed }) });
    const decision = parseDecisionRecord(decisionRaw);
    note(CHAIR_SEAT_ID, session.maxRounds + 1, "decision", decision.recommendation);
    io.save.state({ state: "done", decision, reason: null });
    return decision;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    io.log?.(`council ${session.id} failed: ${reason}`);
    io.save.state({ state: "failed", reason });
    note(MODERATOR_SEAT_ID, session.round, "status", `Failed: ${reason}`);
    return null;
  }
}
