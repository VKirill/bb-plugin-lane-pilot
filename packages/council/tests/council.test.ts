import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  addCouncilMessage,
  councilMigrations,
  createCouncilSession,
  decisionMarkdown,
  decisionFileName,
  getCouncilSession,
  listCouncilMessages,
  moderatorDecision,
  parseDecisionRecord,
  resolveRoles,
  roundNovelty,
  runCouncil,
  setCouncilAgenda,
  setCouncilState,
  type CouncilIo,
  type CouncilSeat,
} from "../src/index";

function openDb() {
  const db = new Database(":memory:");
  for (const sql of councilMigrations) db.exec(sql);
  return db;
}

const seats: CouncilSeat[] = resolveRoles(["skeptic", "product", "demand"]).map((role, index) => ({ id: role.role, role: role.role, title: role.title, instruction: role.instruction, lens: role.lens, providerId: index ? "agy" : "codex", model: `m${index}` }));

const agendaJson = JSON.stringify({ agenda: ["Where do buyers stop?", "What do queries ask for that the cabinet lacks?"], criteria: ["effect on sales", "simplicity", "effort"] });
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

function fakeIo(db: Database.Database, councilId: string, answers: (input: { seat: CouncilSeat | null; round: number; prompt: string }) => string, stopAfter?: number): CouncilIo & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    workspace: "/srv/app",
    spawnTurn: async ({ seat, round, prompt }) => { prompts.push(prompt); return answers({ seat, round, prompt }); },
    evidence: async () => "PROJECT.md: a photo cabinet.\nDirect queries: 40 rows, 12 mention saving a project.",
    save: {
      agenda: (agenda, criteria) => setCouncilAgenda(db, councilId, agenda, criteria),
      message: (message) => addCouncilMessage(db, { councilId, ...message }),
      state: (patch) => setCouncilState(db, councilId, patch),
    },
    isStopped: () => stopAfter !== undefined && prompts.length >= stopAfter,
  };
}

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

describe("council protocol", () => {
  it("runs agenda, rounds with PASS handling, the moderator and the chair's decision", async () => {
    const db = openDb();
    const session = createCouncilSession(db, { id: "c1", projectId: "p", runId: "r", question: "Как поднять повторные покупки в кабинете?", seats, maxRounds: 3 });
    const io = fakeIo(db, "c1", ({ seat, round }) => {
      if (!seat) return round === 0 ? "```json\n" + agendaJson + "\n```" : decisionJson;
      if (round === 1) return `${seat.title}: position on payment and saved projects (${seat.role}).`;
      return seat.role === "skeptic" ? "The saved projects evidence is thin: 12 mentions." : "PASS";
    });
    const decision = await runCouncil(session, io);
    expect(decision?.recommendation).toContain("Remove the account step");
    const after = getCouncilSession(db, "c1")!;
    expect(after.state).toBe("done");
    expect(after.agenda).toHaveLength(2);
    expect(after.decision?.options).toHaveLength(2);
    const feed = listCouncilMessages(db, "c1");
    expect(feed.map((message) => `${message.seatId}:${message.kind}:${message.round}`)).toEqual([
      "chair:agenda:0",
      "product:position:1", "demand:position:1", "skeptic:position:1", "moderator:status:1",
      "product:status:2", "demand:status:2", "skeptic:reply:2", "moderator:status:2",
      "chair:decision:4",
    ]);
    expect(feed.at(-2)?.text).toContain("Time to decide");
    // The skeptic's second prompt carries only what was said since its first turn.
    const skepticRound2 = io.prompts[6]!;
    expect(skepticRound2).toContain("What was said since your last turn");
    expect(skepticRound2).not.toContain("Product director (round 1, position)");
    expect(skepticRound2).toContain("PASS");
    expect(skepticRound2).toContain("checkout at /srv/app");
    expect(skepticRound2).toContain("Do not modify");
    expect(skepticRound2).toContain("Look first at: Backend validation");
    const page = decisionMarkdown(after, after.decision!, feed);
    expect(decisionFileName(after)).toMatch(/^docs\/decisions\/\d{4}-\d{2}-\d{2}-council-как-поднять/);
    for (const part of ["## Options", "### 1. Save the project before payment", "## Dissent", "**Skeptic**", "## Next tasks", "Guest checkout", "<details>"]) expect(page).toContain(part);
  });

  it("stops when the owner asks and fails safely on an unparsable decision", async () => {
    const db = openDb();
    createCouncilSession(db, { id: "c2", projectId: "p", runId: "r", question: "q", seats, maxRounds: 2 });
    const stopped = await runCouncil(getCouncilSession(db, "c2")!, fakeIo(db, "c2", ({ seat, round }) => (!seat && round === 0 ? agendaJson : "position"), 2));
    expect(stopped).toBeNull();
    expect(getCouncilSession(db, "c2")?.state).toBe("stopped");

    createCouncilSession(db, { id: "c3", projectId: "p", runId: "r", question: "q", seats, maxRounds: 1 });
    const failed = await runCouncil(getCouncilSession(db, "c3")!, fakeIo(db, "c3", ({ seat, round }) => (!seat && round === 0 ? agendaJson : seat ? "position" : "not json at all")));
    expect(failed).toBeNull();
    expect(getCouncilSession(db, "c3")).toMatchObject({ state: "failed", reason: expect.stringContaining("no JSON object") });
    expect(() => parseDecisionRecord("{\"summary\":\"x\"}")).toThrow();
  });
});
