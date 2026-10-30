import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { insertReceipt, jevWatch, renderWatch, watchMorningLine } from "@lane-pilot/jev";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-30T12:00:00Z");

function database() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

const put = (db: ReturnType<typeof database>, row: { judgment: string; project?: string; at: number; outcome?: string; status?: string; decidedBy?: "jev" | "fallback" | "escalated"; latencyMs?: number }) => {
  const id = insertReceipt(db, {
    judgment: row.judgment, version: 1, mode: "active", projectId: row.project, inputSha256: `h${row.judgment}${row.at}`, inputChars: 10, questions: 1,
    status: (row.status ?? "ok") as never, decidedBy: row.decidedBy ?? "jev", latencyMs: row.latencyMs ?? 500, at: row.at,
  });
  if (row.outcome) db.prepare("UPDATE lane_pilot_jev_receipt SET outcome=? WHERE id=?").run(row.outcome, id);
};

describe("jev watch", () => {
  it("a quiet window reports the slices, no findings but new_slice", () => {
    const db = database();
    for (let i = 0; i < 6; i++) put(db, { judgment: "route.workflow", at: NOW - i * 60_000, outcome: "agree" });
    const report = jevWatch(db, { sinceMs: NOW - DAY, now: NOW });
    expect(report.slices).toHaveLength(1);
    expect(report.slices[0]!.calls).toBe(6);
    expect(report.findings.map((f) => f.kind)).toEqual(["new_slice"]);
    expect(renderWatch(report)).toContain("route.workflow");
  });

  it("flags a per-project accuracy drop that the judgment's totals hide", () => {
    const db = database();
    // Baseline: both projects agree. Window: p1 still fine, p2 all wrong — the slice p2 is the finding, totals hide it.
    for (let i = 0; i < 10; i++) put(db, { judgment: "output.guard", project: "p1", at: NOW - 10 * DAY + i, outcome: "agree" });
    for (let i = 0; i < 10; i++) put(db, { judgment: "output.guard", project: "p2", at: NOW - 10 * DAY + i, outcome: "agree" });
    // Window: p1 still fine (5 agree), p2 all wrong (5 disagree). Totals 5/10 — the slice p2 is the finding.
    for (let i = 0; i < 5; i++) put(db, { judgment: "output.guard", project: "p1", at: NOW - i, outcome: "agree" });
    for (let i = 0; i < 5; i++) put(db, { judgment: "output.guard", project: "p2", at: NOW - i, outcome: "disagree" });
    const report = jevWatch(db, { sinceMs: NOW - DAY, now: NOW });
    const p2 = report.findings.find((f) => f.project === "p2" && f.kind === "accuracy_drop");
    expect(p2).toBeDefined();
    expect(report.findings.filter((f) => f.kind === "accuracy_drop" && f.project === "p1")).toHaveLength(0);
  });

  it("flags error and escalation spikes and a slice that went dead", () => {
    const db = database();
    for (let i = 0; i < 5; i++) put(db, { judgment: "failure.class", project: "p", at: NOW - 10 * DAY + i, status: "ok" });
    for (let i = 0; i < 5; i++) put(db, { judgment: "failure.class", project: "p", at: NOW - 1 - i, status: "ok" });
    for (let i = 0; i < 5; i++) put(db, { judgment: "failure.class", project: "p", at: NOW - 10 - i, status: "error" });
    for (let i = 0; i < 5; i++) put(db, { judgment: "selfrepair.group", at: NOW - 10 * DAY + i });
    const report = jevWatch(db, { sinceMs: NOW - DAY, now: NOW });
    expect(report.findings.some((f) => f.kind === "error_spike" && f.judgment === "failure.class")).toBe(true);
    expect(report.findings.some((f) => f.kind === "went_dead" && f.judgment === "selfrepair.group")).toBe(true);
    for (let i = 0; i < 6; i++) put(db, { judgment: "route.workflow", at: NOW - i, decidedBy: "escalated" });
    const again = jevWatch(db, { sinceMs: NOW - DAY, now: NOW });
    expect(again.findings.some((f) => f.kind === "escalation_spike" && f.judgment === "route.workflow")).toBe(true);
  });

  it("the morning line says the counts and the worst finding", () => {
    const db = database();
    for (let i = 0; i < 3; i++) put(db, { judgment: "route.workflow", at: NOW - i });
    expect(watchMorningLine(db, NOW)).toBe("Jev: вызовов 3 (эскалаций 0, сбоев 0); деградаций не видно.");
    expect(watchMorningLine(database(), NOW)).toBe("Jev: вызовов 0 (эскалаций 0, сбоев 0); деградаций не видно.");
  });
});
