import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  addCouncilMessage,
  chooseSpeaker,
  councilMigrations,
  councilRunMigrations,
  createCouncilSession,
  getCouncilSession,
  listCouncilMessages,
  resolveRoles,
  DECIDE_REQUEST_TEXT,
  decideRequestedIn,
  maxTurnsOf,
  roomPlan,
  ruleImpulse,
  setCouncilState,
  type CouncilMessage,
  type CouncilSeat,
} from "../src/index";

function openDb() {
  const db = new Database(":memory:");
  for (const sql of [...councilMigrations, ...councilRunMigrations]) db.exec(sql);
  return db;
}

const seats: CouncilSeat[] = resolveRoles(["product", "demand", "skeptic"]).map((role) => ({ id: role.role, role: role.role, title: role.title, instruction: role.instruction, aliases: role.aliases, providerId: "codex", model: "m" }));

describe("impulse and the floor", () => {
  const session = { id: "c", projectId: "p", runId: "r", question: "q", agenda: [], criteria: [], seats, state: "discussion" as const, round: 2, maxRounds: 3, decision: null, decisionPath: null, reason: null, createdAt: 0, updatedAt: 0 };
  const msg = (seatId: string, kind: CouncilMessage["kind"], text: string, seq: number): CouncilMessage => ({ seq, councilId: "c", seatId, round: 2, kind, text, at: 0 });

  it("an addressed seat must speak, the last speaker waits, the owner wakes everyone", () => {
    const feed = [msg("product", "position", "p", 1), msg("demand", "position", "d", 2), msg("skeptic", "position", "s", 3)];
    const last = msg("product", "reply", "Skeptic, what evidence would change your mind?", 4);
    expect(ruleImpulse({ session, seat: seats[2]!, feed: [...feed, last], last })).toMatchObject({ reason: "addressed", score: 1 });
    expect(ruleImpulse({ session, seat: seats[0]!, feed: [...feed, last], last })).toMatchObject({ reason: "none", score: 0 });
    const owner = msg("owner", "owner", "Что с ценами?", 5);
    expect(ruleImpulse({ session, seat: seats[1]!, feed: [...feed, last, owner], last: owner }).score).toBe(0.8);
    const quiet = ruleImpulse({ session, seat: seats[1]!, feed: [msg("product", "reply", "a", 1), msg("skeptic", "reply", "b", 2), msg("product", "reply", "c", 3)], last: msg("product", "reply", "c", 3) });
    expect(quiet.reason).toBe("turn");
    expect(chooseSpeaker([{ seatId: "product", score: 0.1, reason: "none" }, { seatId: "demand", score: 0.2, reason: "none" }], feed)).toBeNull();
    expect(chooseSpeaker([{ seatId: "product", score: 0.6, reason: "turn" }, { seatId: "demand", score: 0.6, reason: "turn" }], feed)?.seatId).toBe("product");
  });
});

describe("the boardroom, read from the feed", () => {
  it("is in its opening lap until every seat has stated a position, then counts turns and laps", () => {
    const db = openDb();
    createCouncilSession(db, { id: "room", projectId: "p", runId: "r", question: "How to raise repeat purchases?", seats, maxRounds: 3 });
    const say = (seatId: string, round: number, kind: CouncilMessage["kind"], text: string) => addCouncilMessage(db, { councilId: "room", seatId, round, kind, text });
    const plan = () => roomPlan(getCouncilSession(db, "room")!, listCouncilMessages(db, "room"));
    expect(plan().opening?.id).toBe("product");
    say("product", 1, "position", "Product: opening position.");
    say("demand", 1, "position", "Demand: opening position.");
    expect(plan()).toMatchObject({ opening: { id: "skeptic" }, turns: 2, lap: 2 });
    say("skeptic", 1, "position", "Skeptic: opening position.");
    expect(plan()).toMatchObject({ opening: null, turns: 3, lap: 2, replies: [] });
    say("product", 2, "reply", "Product reply.");
    say("demand", 2, "status", "PASS (turn)");
    say("skeptic", 2, "reply", "Skeptic reply.");
    const lap = plan();
    expect(lap.turns).toBe(6);
    expect(lap.replies.map((message) => message.seatId)).toEqual(["product", "skeptic"]);
    expect(lap.earlier).toHaveLength(3);
    // A verdict bumps the lap: the replies are weighed and the next lap starts empty.
    setCouncilState(db, "room", { round: 3 });
    expect(plan()).toMatchObject({ lap: 3, replies: [], turns: 6 });
    expect(plan().earlier).toHaveLength(5);
  });

  it("finds a request for the decision in the feed, and caps the turns of a room", () => {
    const db = openDb();
    createCouncilSession(db, { id: "room2", projectId: "p", runId: "r", question: "q", seats, maxRounds: 3 });
    expect(decideRequestedIn(listCouncilMessages(db, "room2"))).toBe(false);
    addCouncilMessage(db, { councilId: "room2", seatId: "moderator", round: 2, kind: "status", text: DECIDE_REQUEST_TEXT });
    expect(decideRequestedIn(listCouncilMessages(db, "room2"))).toBe(true);
    const session = getCouncilSession(db, "room2")!;
    expect(maxTurnsOf(session)).toBe(9);
    expect(maxTurnsOf({ maxRounds: 6, seats: Array.from({ length: 9 }, () => seats[0]!) })).toBe(48);
  });
});
