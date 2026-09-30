import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  addCouncilMessage,
  chooseSpeaker,
  councilMigrations,
  createCouncilSession,
  getCouncilSession,
  listCouncilMessages,
  resolveRoles,
  ruleImpulse,
  runRoom,
  setCouncilAgenda,
  setCouncilState,
  type CouncilMessage,
  type CouncilSeat,
  type RoomIo,
} from "../src/index";

function openDb() {
  const db = new Database(":memory:");
  for (const sql of councilMigrations) db.exec(sql);
  return db;
}

const seats: CouncilSeat[] = resolveRoles(["product", "demand", "skeptic"]).map((role) => ({ id: role.role, role: role.role, title: role.title, instruction: role.instruction, aliases: role.aliases, providerId: "codex", model: "m" }));
const agendaJson = JSON.stringify({ agenda: ["Where do buyers stop?"], criteria: ["effect on sales", "effort"] });
const decisionJson = JSON.stringify({ summary: "s", options: [{ title: "Guest checkout", expectedImpact: "more first purchases", effort: "low", confidence: "high" }], recommendation: "Ship guest checkout.", dissent: [], experiments: [], nextTasks: [] });

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

describe("the boardroom", () => {
  it("lets seats speak on impulse, answers the owner, and decides when the room goes quiet", async () => {
    const db = openDb();
    const session = createCouncilSession(db, { id: "room", projectId: "p", runId: "r", question: "How to raise repeat purchases?", seats, maxRounds: 3 });
    const prompts: Array<{ seat: string; round: number; prompt: string }> = [];
    let ownerSaid = false;
    const pending: CouncilMessage[] = [];
    const io: RoomIo = {
      spawnTurn: async ({ seat, round, prompt }) => {
        prompts.push({ seat: seat?.id ?? "chair", round, prompt });
        if (!seat) return round === 0 ? agendaJson : decisionJson;
        if (round === 1) return seat.role === "skeptic" ? "Skeptic: opening position. Product director, what evidence do you have?" : `${seat.title}: opening position.`;
        if (seat.role === "skeptic" && prompt.includes("Что с ценами")) return "On prices: the owner is right, the evidence is thin.";
        if (seat.role === "product" && prompt.includes("what evidence do you have")) return "Here is the evidence: 12 of 40 queries mention saving.";
        return "PASS";
      },
      evidence: async () => "PROJECT.md: cabinet",
      save: {
        agenda: (agenda, criteria) => setCouncilAgenda(db, "room", agenda, criteria),
        message: (message) => addCouncilMessage(db, { councilId: "room", ...message }),
        state: (patch) => setCouncilState(db, "room", patch),
      },
      isStopped: () => false,
      pollOwner: (afterSeq) => pending.filter((message) => message.seq > afterSeq),
      waitForOwner: async () => {
        if (ownerSaid) return null;
        ownerSaid = true;
        const saved = addCouncilMessage(db, { councilId: "room", seatId: "owner", round: 0, kind: "owner", text: "Что с ценами? Скептик, ответь." });
        pending.push(saved);
        return saved;
      },
      decideRequested: () => false,
      maxTurns: 12,
    };
    const decision = await runRoom(session, io);
    expect(decision?.recommendation).toBe("Ship guest checkout.");
    const after = getCouncilSession(db, "room")!;
    expect(after.state).toBe("done");
    const feed = listCouncilMessages(db, "room");
    const trail = feed.map((message) => `${message.seatId}:${message.kind}`);
    expect(trail.slice(0, 4)).toEqual(["chair:agenda", "product:position", "demand:position", "skeptic:position"]);
    // The skeptic addressed the product director in the opening lap, so the product director replies first, on impulse.
    expect(trail[4]).toBe("moderator:status");
    expect(feed[4]!.text).toContain("Floor: Product director (addressed, rule");
    expect(trail[5]).toBe("product:reply");
    expect(feed[5]!.text).toContain("Here is the evidence");
    expect(trail).toContain("owner:owner");
    const ownerIndex = trail.indexOf("owner:owner");
    expect(feed[ownerIndex + 1]!.text).toContain("Floor: Skeptic (addressed");
    expect(trail[ownerIndex + 2]).toBe("skeptic:reply");
    expect(feed[ownerIndex + 2]!.text).toContain("On prices");
    expect(trail.at(-1)).toBe("chair:decision");
    expect(prompts.some((item) => item.seat === "skeptic" && item.prompt.includes("Что с ценами"))).toBe(true);
  });

  it("stops the moment the owner asks for the decision", async () => {
    const db = openDb();
    const session = createCouncilSession(db, { id: "quick", projectId: "p", runId: "r", question: "q", seats, maxRounds: 3 });
    let decide = false;
    const io: RoomIo = {
      spawnTurn: async ({ seat, round }) => (!seat ? (round === 0 ? agendaJson : decisionJson) : (decide = true, "position")),
      evidence: async () => "e",
      save: { agenda: (a, c) => setCouncilAgenda(db, "quick", a, c), message: (m) => addCouncilMessage(db, { councilId: "quick", ...m }), state: (p) => setCouncilState(db, "quick", p) },
      isStopped: () => false,
      pollOwner: () => [],
      waitForOwner: async () => null,
      decideRequested: () => decide,
    };
    await runRoom(session, io);
    const trail = listCouncilMessages(db, "quick").map((message) => `${message.seatId}:${message.kind}`);
    expect(trail).toEqual(["chair:agenda", "product:position", "demand:position", "skeptic:position", "moderator:status", "chair:decision"]);
  });
});
