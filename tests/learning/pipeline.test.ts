import { describe, expect, it } from "vitest";
import { memorySettingsFor } from "../../src/rooms/memory/server";
import { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule } from "../../src/rooms/self-repair/server";
const insightsStub = { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule };
import { createOwnerMessageHub, TURN_REQUESTED, type EventLike, type ThreadLike } from "../../src/rooms/anamnesis/owner-messages";
import { createDigest } from "../../src/rooms/learning/digest";
import { createDecisions } from "../../src/rooms/learning/decide";
import { createExtractor } from "../../src/rooms/learning/extract";
import { createLiveFeed } from "../../src/rooms/learning/live";
import { createObserver } from "../../src/rooms/learning/observe";
import { pmRulesBlock, pmRulesOf } from "../../src/rooms/learning/pm-rules";
import { lpNotesPort, lpRulesPort } from "../../src/rooms/learning/rules-port";
import { DAY_MS, getObservation, listItems } from "../../src/rooms/learning/store";
import { NOW, config, database } from "./helpers";

// The whole path on fixtures, as a dry run: an owner's correction in a PM chat -> the hub -> the pre-filter -> the night extractor -> a rule on
// trial that the next PM is given -> the day's report -> the owner's answers. No network: the model is a fake.
describe("from a correction to a rule the next PM follows", () => {
  const thread: ThreadLike = { id: "thr_pm", projectId: "proj_1", createdAt: NOW - 30 * DAY_MS, visibility: "visible" };
  const turn = (seq: number, text: string): EventLike => ({ seq, type: TURN_REQUESTED, createdAt: NOW - 1_000, data: { initiator: "user", requestId: `r${seq}`, input: [{ type: "text", text }] } });

  /** A fixed day: three real owner messages, an acknowledgement, and machine text of three kinds. */
  const DAY = [
    "Зачем ты спрашиваешь меня про технические дефекты? Чини сам или отдай специалисту",
    "Всегда пиши отчёты по-русски, коротко",
    "ок",
    "You are the Lane Pilot PM in the selected role.\nRun id: lprun_abc123.\nStart the work.",
    "[bb message from thread:thr_other] result: all green",
    "[Lane Pilot] the phase moved to review",
    "Запусти тесты и покажи результат",
  ];

  it("works end to end: machine text never reaches the extractor, lessons are written, and the owner stays in charge of what is global", async () => {
    const db = database();
    const hub = createOwnerMessageHub();
    const observer = createObserver({ db, now: () => NOW, config: async () => config(), prevReply: async () => "Дефект найден, спросить вас, чинить ли?" });
    hub.subscribe(observer.consumer);
    const events = DAY.map((text, index) => turn(index + 1, text));
    const live = createLiveFeed({ hub, now: () => NOW, readEvents: async () => [...events].reverse() });
    await live.heard(thread, { force: true });

    const seen = db.prepare("SELECT id, state, skip_reason AS why FROM lane_pilot_learning_obs ORDER BY id").all();
    expect(seen).toEqual([
      { id: "thr_pm:1:0", state: "candidate", why: null },
      { id: "thr_pm:2:0", state: "candidate", why: null },
      { id: "thr_pm:3:0", state: "skipped", why: "short" },
      { id: "thr_pm:4:0", state: "skipped", why: "machine" },
      { id: "thr_pm:6:0", state: "skipped", why: "machine" },
      { id: "thr_pm:7:0", state: "candidate", why: null },
    ]);

    const rules = lpRulesPort(db, insightsStub, memorySettingsFor), notes = lpNotesPort(db, insightsStub, memorySettingsFor);
    const prompts: string[] = [];
    const extractor = createExtractor({
      db, rules, notes, now: () => NOW,
      runModel: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ items: [
          { message: "m1", kind: "rule", text: "Never ask the owner about technical defects; fix them or send them to a specialist.", audience: "pm", reach: "project", quote: "Чини сам или отдай специалисту" },
          { message: "m2", kind: "preference", text: "Write reports in Russian, short.", audience: "both", reach: "owner", quote: "по-русски, коротко" },
          { message: "m3", kind: "nothing" },
        ] });
      },
    });
    expect(await extractor.run("proj_1", { batch: 12 })).toMatchObject({ state: "ran", read: 3, items: 2, adopted: 1, waiting: 1 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Зачем ты спрашиваешь");
    for (const machine of ["You are the Lane Pilot PM", "bb message from thread", "the phase moved to review", "lprun_abc123"]) expect(prompts[0]).not.toContain(machine);
    expect(getObservation(db, "thr_pm:1:0")).toMatchObject({ state: "extracted", body: null });
    expect(getObservation(db, "thr_pm:7:0")).toMatchObject({ state: "ignored", body: null });

    // the next PM is given the rule
    const block = pmRulesBlock(pmRulesOf(db, "proj_1"), 1600);
    expect(block.text).toContain("- Never ask the owner about technical defects");
    expect(block.text).not.toContain("Write reports in Russian");

    // the day's report and the owner's answers
    const sent: string[] = [];
    await createDigest({ db, now: () => NOW, announce: async (_, report) => { sent.push(report.text); } }).run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Never ask the owner about technical defects");
    expect(sent[0]).toContain("for all his work: Write reports in Russian, short.");
    const waiting = listItems(db, { states: ["pending_owner"] })[0]!;
    const decisions = createDecisions({ db, rules, notes, remind: async () => "rem", runBb: async () => '{"id":"mem_1"}', now: () => NOW });
    const yes = await decisions.accept(waiting.id);
    expect(yes.item.target).toBe("bb-memory:mem_1");
    expect(yes.item.state).toBe("accepted");
    // every row names its message
    expect(listItems(db).every((item) => item.evidence.includes(item.obsId))).toBe(true);
  });
});
