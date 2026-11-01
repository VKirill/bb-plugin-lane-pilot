import { describe, expect, it } from "vitest";
import { MAX_LISTED, composeDigest, createDigest } from "../../src/rooms/learning/digest";
import { insertItem, listItems, type Item } from "../../src/rooms/learning/store";
import { NOW, database } from "./helpers";

let n = 0;
const item = (over: Partial<Item> = {}): Item => ({
  id: `lrn_${++n}`, obsId: `thr_pm:${n}:0`, projectId: "proj_1", threadId: "thr_pm", kind: "rule", text: `Rule number ${n}`, audience: "pm", reach: "project", dueAt: null, state: "adopted", target: null,
  evidence: `owner message thr_pm:${n}:0`, duplicateOf: null, confirmations: 0, note: null, createdAt: NOW - 3_600_000 + n, decidedAt: null, announcedAt: null, ...over,
});

describe("the daily «what I learned» report (T5)", () => {
  it("lists what is in force apart from what waits for the owner's answer, and tells the PM how to answer", () => {
    const digest = composeDigest([
      item({ text: "Never ask the owner about technical defects." }),
      item({ kind: "decision", state: "noted", audience: null, text: "Invoices go out from Elba." }),
      item({ kind: "preference", state: "pending_owner", target: "bb-memory", reach: "owner", text: "Write reports in Russian, short." }),
      item({ kind: "deadline", state: "pending_owner", target: "reminder", dueAt: Date.UTC(2026, 9, 12), text: "Send the invoice" }),
      item({ state: "pending_owner", target: "replace", text: "Always ask before touching defects.", note: "contradicts: Never ask the owner about technical defects." }),
      item({ state: "duplicate", text: "repeat" }),
    ], NOW)!;
    expect(digest.text).toMatch(/^Lane Pilot learned from the owner's own messages \(report of 2026-10-08\)/);
    const [inForce, waiting] = digest.text.split("Waiting for the owner's yes or no");
    expect(inForce).toContain("Never ask the owner about technical defects.");
    expect(inForce).toContain("decision: Invoices go out from Elba.");
    expect(inForce).toContain('op:"drop"');
    expect(waiting).toContain("for all his work: Write reports in Russian, short.");
    expect(waiting).toContain("reminder for 2026-10-12: Send the invoice");
    expect(waiting).toContain("contradicts a statement in force");
    expect(waiting).toContain('op:"accept"');
    expect(waiting).toContain('op:"reject"');
    expect(digest.text).toContain("1 statement repeated something already in force");
    expect(digest.text).not.toContain("Waiting for the owner's yes or no (nothing is changed before he answers):\n\n");
  });

  it("is silent when there is nothing to report and caps the list", () => {
    expect(composeDigest([], NOW)).toBeNull();
    expect(composeDigest([item({ state: "duplicate" }), item({ state: "dropped" })], NOW)).toBeNull();
    const many = composeDigest(Array.from({ length: MAX_LISTED + 4 }, () => item()), NOW)!;
    expect(many.text.match(/- \[lrn_/g)).toHaveLength(MAX_LISTED);
    expect(many.text).toContain("4 more are listed by");
  });

  // 0.1.458: the report is announced to the owner's list per project, never sent into a PM chat (0.1.443), so no project waits for an open chat.
  it("announces one report per project, once, with what is in force and what waits counted", async () => {
    const db = database();
    insertItem(db, item({ projectId: "proj_1" }));
    insertItem(db, item({ projectId: "proj_2", text: "Second project rule" }));
    insertItem(db, item({ projectId: "proj_1", state: "pending_owner", target: "bb-memory", reach: "owner", text: "Global preference" }));
    const announced: Array<[string, string, number, number]> = [];
    const digest = createDigest({ db, now: () => NOW, announce: async (projectId, report) => { announced.push([projectId, report.text, report.inForce, report.waiting]); } });
    const dry = await digest.run({ dryRun: true });
    expect(dry.map((row) => [row.projectId, row.sent])).toEqual([["proj_1", false], ["proj_2", false]]);
    expect(announced).toEqual([]);
    const first = await digest.run();
    expect(first.find((row) => row.projectId === "proj_1")).toMatchObject({ sent: true, items: 2 });
    expect(first.find((row) => row.projectId === "proj_2")).toMatchObject({ sent: true, items: 1 });
    expect(announced).toHaveLength(2);
    expect(announced.find(([projectId]) => projectId === "proj_1")).toEqual(["proj_1", expect.stringContaining("Global preference"), 1, 1]);
    expect(await digest.run()).toHaveLength(0);
    expect(announced).toHaveLength(2);
    expect(listItems(db, { unannounced: true })).toHaveLength(0);
  });

  it("leaves the items unannounced when the announcement fails", async () => {
    const db = database();
    insertItem(db, item());
    const digest = createDigest({ db, now: () => NOW, announce: async () => { throw new Error("list closed"); } });
    expect(await digest.run()).toMatchObject([{ sent: false }]);
    expect(listItems(db, { unannounced: true })).toHaveLength(1);
  });
});
