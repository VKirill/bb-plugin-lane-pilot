import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";
import { setJevForTests } from "@lane-pilot/jev";
import { getItem, insertItem, listSignals } from "../../src/rooms/learning/store";
import { jevWith } from "./helpers";

describe("the learning room in the mounted plugin", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  async function start() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    return harness;
  }
  const ctx = { threadId: "pm-thread", projectId: "project-a" };

  it("is an action of the memory family, not a tool of its own for the PM", async () => {
    const harness = await start();
    const names = harness.registrations.agentTools.map((tool) => tool.name);
    expect(names).toContain("lane_pilot_learned");
    const family = harness.registrations.agentTools.find((tool) => tool.name === "lane_pilot_memory")!;
    expect(family.instructions).toMatch(/^- learned \{op: string/m);
    expect(family.instructions!.length).toBeLessThanOrEqual(4096);
  });

  it("answers the status in observe mode and changes a setting through the family action", async () => {
    const harness = await start();
    const call = async (args: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_memory", { action: "learned", ...args }, ctx)));
    const status = await call({ op: "status" });
    expect(status).toMatchObject({ mode: "observe", enabled: true, readyForActive: false, today: { judged: 0, judgeCap: 300 } });
    const changed = await call({ op: "config", settings: ["sample=0.5"] });
    expect(changed).toMatchObject({ mode: "observe", sample: 0.5 });
    expect((await call({ op: "config" })).sample).toBe(0.5);
    const refused = await call({ op: "config", settings: ["nope=1"] });
    expect(refused).toMatchObject({ ok: false });
  });

  it("refuses an operation that lacks its argument and an argument of another operation", async () => {
    const harness = await start();
    const call = async (args: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_memory", { action: "learned", ...args }, ctx)));
    expect(await call({ op: "accept" })).toMatchObject({ ok: false });
    expect(await call({ op: "label", id: "x" })).toMatchObject({ ok: false });
    await expect(call({ op: "bogus" })).rejects.toThrow(/invalid/);
  });

  it("reads a question the PM puts to the owner for the routing signal without touching the question", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { getPluginMetadata: async () => ({ role: "pm" }) } } as never });
    Object.assign(bb.ui, { requestInput: async () => ({ outcome: "cancelled", reason: "dismissed" }) });
    await plugin(bb);
    dispose = () => { setJevForTests(null); return harness.lifecycle.dispose(); };
    const db = openDatabase(bb);
    createRun(db, "lprun_1", "project-a");
    setRunThread(db, "lprun_1", "pm-thread");
    const scripted = jevWith(db, []);
    const sure = { ...scripted.jev, judge: async () => ({ by: "jev" as const, decision: 0.9, receiptId: null, answers: {} }) } as never;
    setJevForTests(sure);
    // The owner dismisses the form: the tool answers exactly as before, and the signal is written all the same.
    const answer = String(await harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "Which wording do you prefer for the button?" }, ctx));
    expect(answer).toContain("Владелец закрыл вопрос");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listSignals(db, { kind: "owner_question" })).toMatchObject([{ projectId: "project-a", p: 0.9 }]);
  });
  // Hub 2026-10-28: lrn_52ee07f334eb («каждый понедельник утром…», due 2026-11-02, ~5 days ahead) failed every 30 minutes with
  // «relay limit: a wait longer than 2 hours on nothing Lane Pilot can see»: the cap for a PM snoozing caught the owner's own date.
  it("accepts a date the owner named days ahead as a reminder, not a refused long wait", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const dueAt = Date.now() + 7_522 * 60_000;
    insertItem(db, { id: "lrn_52ee07f334eb", obsId: "thr_5y9sdypguf:1:0", projectId: "project-a", threadId: "thr_5y9sdypguf", kind: "deadline",
      text: "Каждый понедельник утром присылать в этот чат отчёт о файлах репозитория, менявшихся за прошедшую неделю.", audience: null, reach: "project",
      dueAt, state: "pending_owner", target: "reminder", evidence: "owner message thr_5y9sdypguf:1:0 (2026-10-25 12:04) «Каждый понедельник утром собирай отчёт»",
      duplicateOf: null, confirmations: 0, note: null, createdAt: Date.now(), decidedAt: null, announcedAt: null } as never);
    const result = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_memory", { action: "learned", op: "accept", id: "lrn_52ee07f334eb" }, ctx)));
    expect(result.ok).not.toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/relay limit/);
    const item = getItem(db, "lrn_52ee07f334eb")!;
    expect(item.state).toBe("accepted");
    expect(item.target).toMatch(/^reminder:rem/);
  });
});
