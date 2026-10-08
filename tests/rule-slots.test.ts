import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { getRuleProposal, listRuleProposals, upsertLessonProposal } from "@lane-pilot/run-insights";
import { openDatabase } from "../src/database";
import { adoptRuleProposal, adoptWaitingRules } from "../src/server/insights";
import { DEFAULT_RULE_TOKENS, ruleTokens, setRuleBudgets } from "../src/learning/rule-budget";

afterEach(() => setRuleBudgets({ ...DEFAULT_RULE_TOKENS }));
// The pool is a token budget now (src/learning/rule-budget.ts); these tests size it to hold exactly the first twelve writer rules.
const sizeWritersFor = (db: ReturnType<typeof setup>, ids: string[]) =>
  setRuleBudgets({ writer: ids.reduce((sum, id) => sum + ruleTokens(getRuleProposal(db, "proj", id)!.rule), 0) });

const DAY = 86400_000;
function setup() {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  return openDatabase(bb);
}
const WORDS = ["alpha","bravo","charlie","delta","echo","foxtrot","golf","hotel","india","juliet","kilo","lima","mike","november","oscar","papa","quebec","romeo","sierra","tango","uniform","victor","whiskey","xray","yankee","zulu"];
// Each rule its own words: similar ones are counted as repeats of one rule.
const lesson = (db:ReturnType<typeof setup>, n:number, audience:"pm"|"writer", now:number) =>
  upsertLessonProposal(db, "proj", { rule:`${WORDS[n % 26]} ${WORDS[(n * 3 + 1) % 26]}${n} ${WORDS[(n * 5 + 2) % 26]}${n} check ${n}`, audience }, now).id;

it("keeps PM rules out of the writers' cap and takes the slot of the weakest rule on trial when full", () => {
  const db = setup();
  const now = 100 * DAY;
  const first = Array.from({ length: 12 }, (_, i) => lesson(db, i + 1, "writer", now - 10 * DAY));
  sizeWritersFor(db, first);
  for (const id of first) expect(adoptRuleProposal(db, "proj", id, now - 10 * DAY)).not.toBeNull();
  // A PM rule does not compete with the writers' twelve.
  expect(adoptRuleProposal(db, "proj", lesson(db, 50, "pm", now), now)?.state).toBe("accepted");
  // The thirteenth writer rule replaces the oldest unused one on trial.
  const fresh = lesson(db, 13, "writer", now);
  expect(adoptRuleProposal(db, "proj", fresh, now)?.state).toBe("accepted");
  const writers = listRuleProposals(db, "proj", { state:"accepted", limit:100 }).filter((rule) => rule.audience !== "pm");
  // A longer rule may need the room of two weak ones: the pool stays within its tokens.
  expect(writers.length).toBeGreaterThanOrEqual(11);
  expect(writers.length).toBeLessThanOrEqual(12);
  expect(writers.some((rule) => rule.id === fresh)).toBe(true);
  expect(listRuleProposals(db, "proj", { state:"revoked", limit:100 })[0]?.retiredReason).toMatch(/displaced/);
});

it("does not displace a young rule; the waiting one goes on trial later by itself", () => {
  const db = setup();
  const now = 100 * DAY;
  const first = Array.from({ length: 12 }, (_, i) => lesson(db, i + 1, "writer", now));
  sizeWritersFor(db, first);
  for (const id of first) adoptRuleProposal(db, "proj", id, now);
  const waiting = lesson(db, 13, "writer", now);
  expect(adoptRuleProposal(db, "proj", waiting, now)).toBeNull();
  expect(getRuleProposal(db, "proj", waiting)?.state).toBe("proposed");
  expect(adoptWaitingRules(db, now + 4 * DAY)).toBe(1);
  expect(getRuleProposal(db, "proj", waiting)?.state).toBe("accepted");
});
