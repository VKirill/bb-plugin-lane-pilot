import { describe, expect, it } from "vitest";
import { createOwnerMessageHub, TURN_REQUESTED, type EventLike, type ThreadLike } from "../../src/rooms/anamnesis/owner-messages";
import { createDigest } from "../../src/rooms/learning/digest";
import { createDecisions } from "../../src/rooms/learning/decide";
import { createExtractor } from "../../src/rooms/learning/extract";
import { createLiveFeed } from "../../src/rooms/learning/live";
import { createObserver } from "../../src/rooms/learning/observe";
import { pmRulesBlock, pmRulesOf } from "../../src/rooms/learning/pm-rules";
import { lpNotesPort, lpRulesPort } from "../../src/rooms/learning/rules-port";
import { routeOf } from "../../src/rooms/learning/judgment";
import { DAY_MS, getObservation, listItems } from "../../src/rooms/learning/store";
import { NOW, config, database, jevWith } from "./helpers";

// The whole path on fixtures, as a dry run: an owner's correction in a PM chat -> the hub -> Jev and the second opinion -> the extractor ->
// a rule on trial that the next PM is given -> the day's report -> the owner's answers. No network: Jev, OpenAI and the model are fakes.
describe("from a correction to a rule the next PM follows", () => {
  const thread: ThreadLike = { id: "thr_pm", projectId: "proj_1", createdAt: NOW - 30 * DAY_MS, visibility: "visible" };
  const turn = (seq: number, text: string): EventLike => ({ seq, type: TURN_REQUESTED, createdAt: NOW - 1_000, data: { initiator: "user", requestId: `r${seq}`, input: [{ type: "text", text }] } });

  it("works end to end, and the owner stays in charge of what is global", async () => {
    const db = database();
    const { jev } = jevWith(db, [
      [/спрашиваешь/i, { kind: ["correction", 0.85], durable: 0.8, scope: "project" }],
      [/всегда пиши/i, { kind: ["rule", 0.7], durable: 0.7, scope: "owner" }],
    ]);
    const hub = createOwnerMessageHub();
    const secondAsked: string[] = [];
    const observer = createObserver({
      db, jev: () => jev, now: () => NOW, config: async () => config({ mode: "active", agreeSample: 1 }), prevReply: async () => "Дефект найден, спросить вас, чинить ли?",
      decisions: { ask: async (input) => { secondAsked.push(input.text); return { ok: true as const, signals: { kind: "correction", kindP: 0.8, learnP: 0.9, durable: 0.8, scope: "project", scopeP: 0.7, deadline: 0, frustration: 0, mild: 0 }, route: routeOf({ learnP: 0.9, deadline: 0, durable: 0.8 }), tokensIn: 700, latencyMs: 180, model: "gpt-6-luna" }; } },
    });
    hub.subscribe(observer.consumer);
    const events = [turn(1, "Зачем ты спрашиваешь меня про технические дефекты? Чини сам или отдай специалисту"), turn(2, "Всегда пиши отчёты по-русски, коротко"), turn(3, "ок")];
    const live = createLiveFeed({ hub, now: () => NOW, readEvents: async () => [...events].reverse() });
    await live.heard(thread, { force: true });

    const seen = db.prepare("SELECT id, state, skip_reason AS why, final_route AS route FROM lane_pilot_learning_obs ORDER BY id").all();
    expect(seen).toEqual([
      { id: "thr_pm:1:0", state: "candidate", why: null, route: "learn" },
      { id: "thr_pm:2:0", state: "candidate", why: null, route: "learn" },
      { id: "thr_pm:3:0", state: "skipped", why: "short", route: null },
    ]);
    expect(secondAsked).toHaveLength(2);

    const rules = lpRulesPort(db), notes = lpNotesPort(db);
    const prompts: string[] = [];
    const extractor = createExtractor({
      db, jev: () => jev, rules, notes, now: () => NOW,
      runModel: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ items: [
          { message: "m1", kind: "rule", text: "Never ask the owner about technical defects; fix them or send them to a specialist.", audience: "pm", reach: "project", quote: "Чини сам или отдай специалисту" },
          { message: "m2", kind: "preference", text: "Write reports in Russian, short.", audience: "both", reach: "owner", quote: "по-русски, коротко" },
        ] });
      },
    });
    expect(await extractor.run("proj_1", { batch: 12, active: true })).toMatchObject({ state: "ran", read: 2, items: 2, adopted: 1, waiting: 1 });
    expect(prompts[0]).toContain("Зачем ты спрашиваешь");
    expect(getObservation(db, "thr_pm:1:0")).toMatchObject({ state: "extracted", body: null });

    // the next PM is given the rule
    const block = pmRulesBlock(pmRulesOf(db, "proj_1"), 1600);
    expect(block.text).toContain("- Never ask the owner about technical defects");
    expect(block.text).not.toContain("Write reports in Russian");

    // the day's report and the owner's answers
    const sent: string[] = [];
    await createDigest({ db, now: () => NOW, pmThread: () => "thr_pm", send: async (_, text) => { sent.push(text); } }).run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Never ask the owner about technical defects");
    expect(sent[0]).toContain("for all his work: Write reports in Russian, short.");
    const waiting = listItems(db, { states: ["pending_owner"] })[0]!;
    const decisions = createDecisions({ db, rules, notes, remind: async () => "rem", now: () => NOW });
    const yes = await decisions.accept(waiting.id);
    expect(yes.run).toContain("bb memory add --scope 'global' --kind 'preference'");
    expect(yes.item.state).toBe("accepted");
    // every row names its message
    expect(listItems(db).every((item) => item.evidence.includes(item.obsId))).toBe(true);
  });
});
