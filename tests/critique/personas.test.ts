import { describe, expect, it } from "vitest";
import { criticPersonas, unionCriticFails, type CodeCritiqueResult } from "../../src/rooms/critique/code-critique";

const row = (status: "pass" | "rework" | "block", id: string): CodeCritiqueResult => ({
  decision: status === "pass" ? "approve" : "changes_requested",
  summary: status,
  status,
  findings: status === "pass" ? [] : [{ id, severity: "blocking", finding: id, criterion: "acceptance" }],
});

describe("two critic personas", () => {
  it("runs author and hostile only at high and critical, and fails if either fails", () => {
    expect(criticPersonas("medium")).toEqual([undefined]);
    expect(criticPersonas("high")).toEqual(["author", "hostile"]);
    expect(criticPersonas("critical")).toEqual(["author", "hostile"]);
    const pass = row("pass", "ok");
    const missed = row("rework", "missed-check");
    const hostile = row("block", "auth-hole");
    expect(unionCriticFails([pass, missed])).toMatchObject({ status: "rework", decision: "changes_requested", findings: [{ id: "missed-check" }] });
    expect(unionCriticFails([missed, hostile]).status).toBe("block");
    expect(unionCriticFails([missed, hostile]).findings.map((finding) => finding.id)).toEqual(["missed-check", "auth-hole"]);
    expect(unionCriticFails([pass, pass])).toBe(pass);
  });
});