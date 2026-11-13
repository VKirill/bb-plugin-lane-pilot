import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { SECTION_RANK_BOOST, liftPreferred, parseMemorySettings, searchMemoryRecords, storeMemoryRecords } from "@lane-pilot/memory-core";
import { pmMemoryContext } from "../src/rooms/memory/server/memory-mix";
import { threadMemoryBlock } from "../src/rooms/memory/server/thread-block";
import { openDatabase } from "../src/rooms/plugin-db";

const limits = { sourceSha256: "d".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const fresh = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const put = (db: ReturnType<typeof fresh>, content: string, scope: string[], kind: "note" | "core" = "note") => storeMemoryRecords(db, { projectId: "P", personalBot: "", ...limits, scope, origin: "maintainer", entries: [{ kind, content, concepts: kind === "core" ? ["convention"] : ["bay"] }] }).insertedIds[0]!;
const ask = (db: ReturnType<typeof fresh>, q: string, chain: string[], scopeMode?: "section" | "project", limit = 20) =>
  searchMemoryRecords(db, "P", q, limit, "bm25", "subagent", "", { chain, includeObserved: true, ...(scopeMode ? { scopeMode } : {}) }).map((r) => r.id);

describe("memory.scope", () => {
  it("defaults to section and reads project", () => {
    expect(parseMemorySettings({}).scope).toBe("section");
    expect(parseMemorySettings({ "memory.scope": "project" }).scope).toBe("project");
    expect(parseMemorySettings({ "memory.scope": "nonsense" }).scope).toBe("section");
  });

  it("section: a note of section A is not visible from section B or the root; project: it is, from everywhere", () => {
    const db = fresh();
    const a = put(db, "The gantry crane at pier nine is greased on the first Friday.", ["section:A"]);
    const root = put(db, "The gantry crane inspection is signed at the pier office.", []);
    const q = "gantry crane pier";
    expect(ask(db, q, ["section:B"])).toEqual([root]);
    expect(ask(db, q, ["section:B"], "section")).toEqual([root]);
    expect(ask(db, q, [])).toEqual([root]);
    expect(ask(db, q, ["section:A"])).toEqual(expect.arrayContaining([a, root]));
    expect(ask(db, q, ["section:B"], "project")).toEqual(expect.arrayContaining([a, root]));
    expect(ask(db, q, [], "project")).toEqual(expect.arrayContaining([a, root]));
  });

  it("the section stays on the note: a write in section A records section A whatever the scope", () => {
    const db = fresh();
    const a = put(db, "Lanterns in the bay are swapped on Sunday.", ["section:A"]);
    const row = db.prepare("SELECT scope_json FROM lane_pilot_memory WHERE id=?").get(a) as { scope_json: string };
    expect(JSON.parse(row.scope_json)).toEqual(["section:A"]);
  });

  it("the boost lifts a note of the asking section by SECTION_RANK_BOOST places, and only under project", () => {
    const db = fresh();
    // The word count decides the order of the bm25 engine: five notes of other sections say «lantern» more often than the one of the asking section.
    const others = [6, 5, 4, 3, 2].map((n, i) => put(db, `${Array(n).fill("lantern").join(" ")} bay note ${i} of section B`, ["section:B"]));
    const own = put(db, "lantern bay note of section A", ["section:A"]);
    expect(SECTION_RANK_BOOST).toBe(3);
    expect(ask(db, "lantern", ["section:A"], "project")).toEqual([...others.slice(0, 2), own, ...others.slice(2)]);
    expect(ask(db, "lantern", ["section:A"], "section")).toEqual([own]);
    // another asking section: nothing of the A note is lifted, it keeps its place by relevance
    expect(ask(db, "lantern", ["section:B"], "project").at(-1)).toBe(own);
    // an ancestor section's notes are the asking section's too
    expect(ask(db, "lantern", ["section:A", "section:A1"], "project")).toContain(own);
  });

  it("liftPreferred is stable and leaves a list without a preferred item alone", () => {
    expect(liftPreferred([1, 2, 3, 4, 5], (n) => n === 5)).toEqual([1, 5, 2, 3, 4]);
    expect(liftPreferred([1, 2, 3], () => false)).toEqual([1, 2, 3]);
    expect(liftPreferred([1, 2, 3, 4, 5, 6], (n) => n >= 5)).toEqual([1, 5, 2, 6, 3, 4]);
  });

  it("the PM context follows the setting: a sibling section's note arrives only under project", () => {
    const db = fresh();
    put(db, "The gantry crane at pier nine is greased on the first Friday of the month.", ["section:A"]);
    const q = "When is the gantry crane at pier nine greased?";
    const closed = pmMemoryContext(db as never, "P", parseMemorySettings({}), q, ["section:B"], "pm", null);
    expect(closed.records).toEqual([]);
    const open = pmMemoryContext(db as never, "P", parseMemorySettings({ "memory.scope": "project" }), q, ["section:B"], "pm", null);
    expect(open.records.map((r) => r.content)).toEqual([expect.stringContaining("gantry crane")]);
  });

  it("the thread block lists the core conventions of every section only under project", () => {
    const db = fresh();
    put(db, "Convention of the A section: lanterns are green.", ["section:A"], "core");
    const block = () => threadMemoryBlock(db as never, { projectId: "P", threadId: "thr_plain" }) ?? "";
    expect(block()).not.toContain("lanterns are green");
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,updated_at) VALUES ('P','','memory.scope',?,1)").run(JSON.stringify("project"));
    expect(block()).toContain("lanterns are green");
  });
});
