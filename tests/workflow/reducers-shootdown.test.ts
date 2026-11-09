import { describe, expect, it } from "vitest";
import { REDUCERS } from "@lane-pilot/workflow-engine";
import type { JoinInput } from "@lane-pilot/workflow-engine";

type Row = Record<string, unknown>;
const rows = (...items: Array<{ item: unknown; data?: Row; error?: string; blocked?: boolean }>): JoinInput => {
  const all: JoinInput["rows"] = items.map((entry, branch) => ({ branch, item: entry.item, ok: entry.data !== undefined, ...(entry.data ? { data: entry.data } : { error: entry.error ?? "x", blocked: entry.blocked ?? false }) }));
  return { rows: all, results: all.filter((row) => row.ok).map((row) => row.data!), failed: all.filter((row) => !row.ok).map((row) => ({ branch: row.branch, item: row.item, error: row.error!, blocked: row.blocked! })), items: all.map((row) => row.item) };
};

describe("reduce.lp.brainstorm.shootdown", () => {
  it("flattens objections tagged with their lens and counts Blockers", () => {
    const out = REDUCERS["reduce.lp.brainstorm.shootdown"]!(rows(
      { item: "yagni", data: { lens: "yagni", ok: true, objections: [{ severity: "Blocker", objection: "exists", evidence: "src/x.ts:1", fix: "reuse" }, { severity: "Nit", objection: "name" }] } },
      { item: "cost", data: { lens: "cost", ok: true, objections: [{ severity: "Major", objection: "quota" }] } },
    ));
    expect(out).toEqual({
      objections: [
        { severity: "Blocker", objection: "exists", evidence: "src/x.ts:1", fix: "reuse", lens: "yagni" },
        { severity: "Nit", objection: "name", lens: "yagni" },
        { severity: "Major", objection: "quota", lens: "cost" },
      ],
      blocker_count: 1,
      ok_count: 2,
      failed_lenses: [],
    });
  });
  it("a lens that never ran or came back not-ok is a failed lens, never zero findings", () => {
    const out = REDUCERS["reduce.lp.brainstorm.shootdown"]!(rows(
      { item: "ops", data: { lens: "ops", ok: true, objections: [] } },
      { item: "debt", data: { lens: "debt", ok: false } },
      { item: "catalyst", error: "timeout" },
    ));
    expect(out).toEqual({ objections: [], blocker_count: 0, ok_count: 1, failed_lenses: ["catalyst", "debt"] });
  });
  it("the lens tag falls back to the branch item when the child omits it", () => {
    const out = REDUCERS["reduce.lp.brainstorm.shootdown"]!(rows(
      { item: "ux", data: { ok: true, objections: [{ severity: "Blocker", objection: "dead end" }] } },
    ));
    expect((out.objections as Row[])[0]!.lens).toBe("ux");
    expect(out.blocker_count).toBe(1);
  });
});
