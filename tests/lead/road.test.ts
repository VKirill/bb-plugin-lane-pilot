import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { addRoad, decideRoad, doneRoad, getRoad, listRoad, proposeRoad, rejectRoad, renderRoadTree, roadCounts, roadMarkdown, roadTree } from "../../src/rooms/lead/server/road";
import { openDatabase } from "../../src/rooms/plugin-db";

// The migration that owns this table lands in a sibling change; the test cannot wait for it, so the fixture applies the same DDL.
const world = () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  return db;
};

const direction = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: "Grow revenue", kind: "direction" as const, source: "lead" as const, why: "the owner wants growth", ...extra });
const option = (id: string, parentId: string, extra: Record<string, unknown> = {}) =>
  ({ id, parentId, title: "Ship paid plans", kind: "option" as const, source: "lead" as const, why: "users asked for it", ...extra });

describe("addRoad", () => {
  it("adds a direction without a parent and an option under it", () => {
    const db = world();
    const dir = addRoad(db, direction("d1"), 100);
    expect(dir).toMatchObject({ id: "d1", parent_id: null, state: "open", created_at: 100, updated_at: 100 });
    const opt = addRoad(db, option("o1", "d1", { evidence: [{ kind: "task", ref: "task_1" }] }), 200);
    expect(opt.parent_id).toBe("d1");
    expect(JSON.parse(opt.evidence_json)).toEqual([{ kind: "task", ref: "task_1" }]);
  });

  it("throws when an option has no parent or an unknown one", () => {
    const db = world();
    expect(() => addRoad(db, { title: "orphan", kind: "option", source: "lead", why: "no parent" })).toThrow(/parent/);
    expect(() => addRoad(db, option("o2", "ghost"))).toThrow(/unknown parent/);
  });

  it("validates title, why and evidence", () => {
    const db = world();
    expect(() => addRoad(db, direction("bad", { title: "  " }))).toThrow(/title/);
    expect(() => addRoad(db, direction("bad2", { why: "" }))).toThrow(/why/);
    expect(() => addRoad(db, direction("bad3", { evidence: Array.from({ length: 13 }, (_, i) => ({ kind: "note", ref: `r${i}` })) }))).toThrow(/12/);
    expect(() => addRoad(db, direction("bad4", { evidence: [{ kind: "note", ref: " " }] }))).toThrow(/ref/);
  });
});

describe("rejectRoad and doneRoad", () => {
  it("needs a reason of at least 10 chars, appends it, and keeps the row", () => {
    const db = world();
    addRoad(db, direction("d1"));
    expect(() => rejectRoad(db, "d1", "too short", "owner")).toThrow(/10/);
    expect(rejectRoad(db, "d1", "costs too much for now", "owner", 500)).toBe(true);
    const row = getRoad(db, "d1")!;
    expect(row.state).toBe("rejected");
    expect(row.why).toContain("rejected by owner: costs too much for now");
    expect(row.decided_at).toBe(500);
    expect(rejectRoad(db, "d1", "rejecting again is fine", "owner")).toBe(false);
    expect(rejectRoad(db, "nope", "rejecting an unknown id", "owner")).toBe(false);
    expect(getRoad(db, "d1")).toBeDefined();
  });

  it("marks a branch done once, with an optional note", () => {
    const db = world();
    addRoad(db, direction("d1"));
    expect(doneRoad(db, "d1", "shipped in run 7", 900)).toBe(true);
    expect(getRoad(db, "d1")!.why).toContain("done: shipped in run 7");
    expect(doneRoad(db, "d1")).toBe(false);
    expect(doneRoad(db, "ghost")).toBe(false);
  });
});

describe("propose → decide", () => {
  it("walks open → proposed → accepted/later/rejected and refuses wrong states", () => {
    const db = world();
    addRoad(db, direction("a"));
    addRoad(db, direction("b"));
    addRoad(db, direction("c"));
    expect(decideRoad(db, "a", "yes")).toBe(false);
    expect(proposeRoad(db, "a", "dec_1", 10)).toBe(true);
    expect(getRoad(db, "a")).toMatchObject({ state: "proposed", proposed_at: 10, decision_id: "dec_1" });
    expect(decideRoad(db, "a", "yes", undefined, 20)).toBe(true);
    expect(getRoad(db, "a")!.state).toBe("accepted");
    proposeRoad(db, "b", "dec_2", 10);
    expect(decideRoad(db, "b", "later", undefined, 20)).toBe(true);
    expect(getRoad(db, "b")!.state).toBe("later");
    expect(proposeRoad(db, "b", "dec_3", 30)).toBe(true);
    proposeRoad(db, "c", "dec_4", 10);
    expect(decideRoad(db, "c", "no", "too risky", 20)).toBe(true);
    const c = getRoad(db, "c")!;
    expect(c.state).toBe("rejected");
    expect(c.why).toContain("owner: no too risky");
    expect(proposeRoad(db, "c", "dec_5", 40)).toBe(false);
  });
});

describe("roadTree and renderRoadTree", () => {
  const fixture = () => {
    const db = world();
    addRoad(db, direction("root", { title: "Direction" }), 1);
    addRoad(db, option("kid", "root", { title: "Option A", evidence: [{ kind: "file", ref: "src/x.ts" }] }), 2);
    addRoad(db, option("dead", "root", { title: "Option B" }), 3);
    rejectRoad(db, "dead", "proved too expensive", "pm", 4);
    return db;
  };

  it("hides rejected branches by default and shows them with history", () => {
    const db = fixture();
    const tree = roadTree(db);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.row.id)).toEqual(["kid"]);
    const full = roadTree(db, { history: true });
    expect(full[0].children.map((node) => node.row.id)).toEqual(["kid", "dead"]);
  });

  it("renders marks, indentation, why and evidence", () => {
    const db = fixture();
    expect(renderRoadTree(roadTree(db, { history: true }))).toBe(
      "· Direction [direction/open, lead] root\n" +
      "  why: the owner wants growth\n" +
      "  · Option A [option/open, lead] kid\n" +
      "    why: users asked for it\n" +
      "    evidence: src/x.ts\n" +
      "  ✗ Option B [option/rejected, lead] dead\n" +
      "    why: users asked for it\n\nrejected by pm: proved too expensive",
    );
  });
});

describe("listRoad and roadCounts", () => {
  it("filters and counts by state and project", () => {
    const db = world();
    addRoad(db, direction("p1", { projectId: "alpha" }), 1);
    addRoad(db, direction("p2", { projectId: "beta" }), 2);
    addRoad(db, direction("up"), 3);
    addRoad(db, option("o1", "p1", { projectId: "alpha" }), 4);
    rejectRoad(db, "o1", "not worth the effort", "lead", 5);
    expect(listRoad(db, { kind: "direction" }).map((row) => row.id)).toEqual(["up", "p2", "p1"]);
    expect(listRoad(db, { projectId: null }).map((row) => row.id)).toEqual(["up"]);
    expect(listRoad(db, { projectId: "alpha", state: ["rejected", "done"] }).map((row) => row.id)).toEqual(["o1"]);
    expect(roadCounts(db)).toEqual({ open: 3, proposed: 0, accepted: 0, later: 0, rejected: 1, done: 0 });
  });
});

describe("roadMarkdown", () => {
  it("has front matter, per-project sections, a History section, and is deterministic", () => {
    const db = world();
    addRoad(db, direction("d1", { projectId: "alpha" }), 1);
    addRoad(db, option("o1", "d1", { title: "Option A" }), 2);
    addRoad(db, direction("d2", { title: "Meta" }), 3);
    addRoad(db, direction("d3", { projectId: "alpha", title: "Old" }), 4);
    rejectRoad(db, "d3", "superseded by d1", "owner", 5);
    const md = roadMarkdown(db, 1_700_000_000_000);
    expect(md).toContain('title: "ROAD"');
    expect(md).toContain('generated: "2023-11-14T22:13:20.000Z"');
    expect(md).toContain("rejected: 1");
    expect(md).toContain("## alpha");
    expect(md).toContain("## Above projects");
    expect(md).toContain("- **Grow revenue** (direction/open, lead)");
    expect(md).toContain("## History");
    expect(md).toContain("- **Old** (direction/rejected, lead)");
    expect(roadMarkdown(db, 1_700_000_000_000)).toBe(md);
  });
});
