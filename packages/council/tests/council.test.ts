import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  addCouncilMessage,
  councilMigrations,
  councilRunMigrations,
  createCouncilSession,
  decisionMarkdown,
  decisionFileName,
  getCouncilSession,
  listCouncilMessages,
  moderatorDecision,
  parseDecisionRecord,
  resolveRoles,
  roundNovelty,
  roundsPlan,
  setCouncilRun,
  setCouncilState,
  verdictWritten,
  type CouncilSeat,
} from "../src/index";

function openDb() {
  const db = new Database(":memory:");
  for (const sql of [...councilMigrations, ...councilRunMigrations]) db.exec(sql);
  return db;
}

const seats: CouncilSeat[] = resolveRoles(["skeptic", "product", "demand"]).map((role, index) => ({ id: role.role, role: role.role, title: role.title, instruction: role.instruction, lens: role.lens, providerId: index ? "agy" : "codex", model: `m${index}` }));

const decisionJson = JSON.stringify({
  summary: "Buyers stop at the payment step; queries ask for saved projects.",
  options: [
    { title: "Save the project before payment", expectedImpact: "fewer drops at payment", effort: "medium", confidence: "medium", evidence: ["12 of 40 queries mention saving"] },
    { title: "Remove the account step", expectedImpact: "faster first purchase", effort: "low", confidence: "high", evidence: [] },
  ],
  recommendation: "Remove the account step first, then saved projects.",
  dissent: [{ seat: "Skeptic", point: "Guest checkout may raise refunds." }],
  experiments: [{ hypothesis: "Guest checkout raises first purchases", metric: "first-purchase rate over two weeks" }],
  nextTasks: [{ title: "Guest checkout", objective: "Let a visitor buy without an account.", acceptance: ["No account form before payment"], toAgent: "writer" }],
});

describe("council roles and moderator", () => {
  it("orders the skeptic last and refuses unknown roles", () => {
    expect(resolveRoles(["skeptic", "product", "demand"]).map((role) => role.role)).toEqual(["product", "demand", "skeptic"]);
    expect(resolveRoles().map((role) => role.role)).toEqual(["product", "demand", "audience", "skeptic"]);
    expect(() => resolveRoles(["cfo"])).toThrow(/unknown council role/);
  });

  it("ends the discussion on the round cap, on repetition or when most seats pass", () => {
    expect(moderatorDecision({ round: 1, maxRounds: 3, novelty: 1, passed: 0, seats: 4 })).toBe("continue");
    expect(moderatorDecision({ round: 3, maxRounds: 3, novelty: 1, passed: 0, seats: 4 })).toBe("synthesize");
    expect(moderatorDecision({ round: 2, maxRounds: 3, novelty: 0.05, passed: 0, seats: 4 })).toBe("synthesize");
    expect(moderatorDecision({ round: 2, maxRounds: 3, novelty: 0.9, passed: 2, seats: 4 })).toBe("synthesize");
    expect(roundNovelty(["payment step drops buyers"], ["payment step drops buyers again"])).toBeLessThan(0.5);
    expect(roundNovelty(["payment step drops buyers"], ["saved projects requested by queries"])).toBeGreaterThan(0.5);
  });
});

describe("council steps", () => {
  const say = (db: Database.Database, id: string, seatId: string, round: number, kind: "position" | "reply" | "status" | "decision", text: string) => addCouncilMessage(db, { councilId: id, seatId, round, kind, text });

  it("reads the fixed rounds from the feed: who is due, who passed, what the moderator already wrote", () => {
    const db = openDb();
    createCouncilSession(db, { id: "c1", projectId: "p", runId: "r", question: "q", seats, maxRounds: 3 });
    let session = getCouncilSession(db, "c1")!;
    expect(roundsPlan(session, [])).toMatchObject({ round: 1, seat: { id: "product" } });
    for (const seat of seats.slice(0, 2)) say(db, "c1", seat.id, 1, "position", `${seat.id} position`);
    session = getCouncilSession(db, "c1")!;
    expect(roundsPlan(session, listCouncilMessages(db, "c1")).seat?.id).toBe(seats[2]!.id);
    say(db, "c1", seats[2]!.id, 1, "position", "last position");
    const done = roundsPlan(session, listCouncilMessages(db, "c1"));
    expect(done).toMatchObject({ round: 1, seat: null, passed: 0 });
    expect(done.said).toHaveLength(3);
    expect(verdictWritten(listCouncilMessages(db, "c1"), 1)).toBeNull();
    say(db, "c1", "moderator", 1, "status", "Another round (rule; novelty 100%, passed 0/3)");
    expect(verdictWritten(listCouncilMessages(db, "c1"), 1)).toBe("continue");
    setCouncilState(db, "c1", { round: 2 });
    session = getCouncilSession(db, "c1")!;
    say(db, "c1", "product", 2, "status", "PASS");
    const second = roundsPlan(session, listCouncilMessages(db, "c1"));
    expect(second).toMatchObject({ round: 2, passed: 1 });
    expect(second.seat?.id).toBe(seats[1]!.id);
    expect(second.earlier).toHaveLength(3);
    say(db, "c1", "moderator", 2, "status", "Time to decide (rule; novelty 4%, passed 1/3)");
    expect(verdictWritten(listCouncilMessages(db, "c1"), 2)).toBe("synthesize");
  });

  it("stores the graph run that drives a session", () => {
    const db = openDb();
    createCouncilSession(db, { id: "c2", projectId: "p", runId: "r", question: "q", seats, maxRounds: 2 });
    expect(getCouncilSession(db, "c2")?.wfRunId).toBeNull();
    setCouncilRun(db, "c2", "wfrun_1");
    expect(getCouncilSession(db, "c2")?.wfRunId).toBe("wfrun_1");
  });

  it("renders the decision page and clips an overlong decision record", () => {
    const db = openDb();
    createCouncilSession(db, { id: "c3", projectId: "p", runId: "r", question: "Как поднять повторные покупки в кабинете?", seats, maxRounds: 3 });
    const decision = parseDecisionRecord(decisionJson);
    setCouncilState(db, "c3", { state: "done", decision });
    const after = getCouncilSession(db, "c3")!;
    const feed = listCouncilMessages(db, "c3");
    expect(decision.recommendation).toContain("Remove the account step");
    const page = decisionMarkdown(after, after.decision!, feed);
    expect(decisionFileName(after)).toMatch(/^docs\/decisions\/\d{4}-\d{2}-\d{2}-council-как-поднять/);
    for (const part of ["## Options", "### 1. Save the project before payment", "## Dissent", "**Skeptic**", "## Next tasks", "Guest checkout", "<details>"]) expect(page).toContain(part);
    expect(() => parseDecisionRecord("{\"summary\":\"x\"}")).toThrow();
    const long = parseDecisionRecord(JSON.stringify({ summary: "s", options: [{ title: "t", expectedImpact: "i", effort: "low", confidence: "high" }], recommendation: "r", experiments: [{ hypothesis: "h", metric: "m".repeat(900) }] }));
    expect(long.experiments[0]!.metric.length).toBe(300);
    expect(long.experiments[0]!.metric.endsWith("…")).toBe(true);
  });
});
