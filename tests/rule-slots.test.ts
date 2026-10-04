import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { getRuleProposal, listRuleProposals, upsertLessonProposal } from "@lane-pilot/run-insights";
import { openDatabase } from "../src/database";
import { adoptRuleProposal, adoptWaitingRules } from "../src/server/insights";

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
  for (let n = 1; n <= 12; n++) expect(adoptRuleProposal(db, "proj", lesson(db, n, "writer", now - 10 * DAY), now - 10 * DAY)).not.toBeNull();
  // A PM rule does not compete with the writers' twelve.
  expect(adoptRuleProposal(db, "proj", lesson(db, 50, "pm", now), now)?.state).toBe("accepted");
  // The thirteenth writer rule replaces the oldest unused one on trial.
  const fresh = lesson(db, 13, "writer", now);
  expect(adoptRuleProposal(db, "proj", fresh, now)?.state).toBe("accepted");
  const writers = listRuleProposals(db, "proj", { state:"accepted", limit:100 }).filter((rule) => rule.audience !== "pm");
  expect(writers).toHaveLength(12);
  expect(listRuleProposals(db, "proj", { state:"revoked", limit:100 })[0]?.retiredReason).toMatch(/displaced/);
});

it("does not displace a young rule; the waiting one goes on trial later by itself", () => {
  const db = setup();
  const now = 100 * DAY;
  for (let n = 1; n <= 12; n++) adoptRuleProposal(db, "proj", lesson(db, n, "writer", now), now);
  const waiting = lesson(db, 13, "writer", now);
  expect(adoptRuleProposal(db, "proj", waiting, now)).toBeNull();
  expect(getRuleProposal(db, "proj", waiting)?.state).toBe("proposed");
  expect(adoptWaitingRules(db, now + 4 * DAY)).toBe(1);
  expect(getRuleProposal(db, "proj", waiting)?.state).toBe("accepted");
});
