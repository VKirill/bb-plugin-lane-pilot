import { describe, expect, it } from "vitest";
import { costUsd, resolveRoleModel } from "@lane-pilot/models";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";

/**
 * `web-research` never finished live: all 3 runs stopped with budget_exceeded:cost after the frame step and three search children
 * (5 steps, 1.0-1.2 M tokens, $2.97-$3.39), because the graph's whole budget was $2 while one search child (a specialist:tavily on the
 * role table's Opus 5.5 that reads 2-4 full pages) costs about $0.9. This pins the budget to what the graph's own nodes cost at the
 * role models' prices: the dearest path the graph allows has to fit with room to spare.
 */
type Profile = { uncached: number; cacheRead: number; cacheWrite: number; output: number };
// Tokens of one turn-by-turn session of each kind of step (planning figures, calibrated on the three live runs: a child ~ $0.84 on Opus 5.5).
const PROFILE = {
  frame: { uncached: 20_000, cacheRead: 100_000, cacheWrite: 20_000, output: 4_000 },
  search: { uncached: 30_000, cacheRead: 600_000, cacheWrite: 60_000, output: 15_000 },
  /** Claims and the report get every source in their context. */
  write: { uncached: 60_000, cacheRead: 400_000, cacheWrite: 80_000, output: 25_000 },
} satisfies Record<string, Profile>;
const DEEP_SUBQUESTIONS = 6; // quality_mode: full (deep) = 6 sub-questions
const HEADROOM = 1.25;

const graph = builtinWorkflow("web-research")!;
const node = (id: string) => graph.nodes.find((item) => item.id === id) as Record<string, any>;
const priceOf = (role: string, profile: Profile): number => {
  const picked = resolveRoleModel(role, {});
  const usd = costUsd(picked.model, profile);
  if (usd === null) throw new Error(`no price for ${picked.model}`);
  return usd;
};
const visits = (id: string): number => node(id).guards?.maxVisits ?? 1;

/** The dearest path: the clarification loop once, every sub-question searched, claims and report each at their visit limit. */
function worstCaseUsd(): number {
  const search = node("search");
  return visits("frame") * priceOf(node("frame").role, PROFILE.frame)
    + DEEP_SUBQUESTIONS * priceOf(search.child.role, PROFILE.search)
    + visits("claims") * priceOf(node("claims").role, PROFILE.write)
    + visits("report") * priceOf(node("report").role, PROFILE.write);
}

describe("the budget of web-research", () => {
  it("reads its roles from the graph: the analyst on Opus 5.5, the tavily employee on Sonnet 5.5", () => {
    expect(node("frame").role).toBe("analyst");
    expect(node("search").child.role).toBe("specialist:tavily");
    expect(resolveRoleModel("analyst", {}).model).toBe("claude-opus-5-5");
    // Employees run on Sonnet high by the role table (employees batch): the search child is no longer an Opus author.
    expect(resolveRoleModel("specialist:tavily", {}).model).toBe("claude-sonnet-5-5");
  });

  it("the frame and three search children cost what the role table prices them, and stay under the budget", () => {
    const firstHalf = priceOf("analyst", PROFILE.frame) + 3 * priceOf("specialist:tavily", PROFILE.search);
    expect(firstHalf).toBeGreaterThan(1.2);
    expect(firstHalf).toBeLessThan(graph.budget.maxCostUsd!);
  });

  it("covers the dearest path of the graph at the role models' prices, with headroom", () => {
    const worst = worstCaseUsd();
    expect(graph.budget.maxCostUsd).toBeGreaterThanOrEqual(worst * HEADROOM);
    // A limit that no run could reach protects nothing: it stays within about twice the dearest path.
    expect(graph.budget.maxCostUsd!).toBeLessThanOrEqual(worst * 2);
  });

  it("allows every step of the dearest path, and the hour the searches take", () => {
    // frame (twice with the clarification), the fan-out and its children, claims, report, check and deliver (twice on a citation repair), the exits.
    const steps = visits("frame") + 1 + DEEP_SUBQUESTIONS + visits("claims") + visits("report") * 2 + visits("report") * 2 + 1 + 1;
    expect(graph.budget.maxSteps).toBeGreaterThanOrEqual(Math.ceil(steps * HEADROOM));
    expect(graph.budget.maxWallSeconds).toBeGreaterThanOrEqual(60 * 60);
  });
});
