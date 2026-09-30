import { describe, expect, it } from "vitest";
import { exportedFileName, laneMemoryFileToCandidate, parseLaneMemoryFile, renderLaneMemoryFile } from "../src/files";

const sample = `---
id: worktree-routing
schema_version: 2
status: active
memory_type: normative
truth_mode: decision
claim: Parallel writers use a worktree each; in_place means one at a time
language: en
source:
  authority: owner
sensitivity: internal
context_priority: always
retrieval:
  areas: [procedures, "lanes"]
  hint: worktree, параллельные полосы
---

Shared checkouts see each other's half-done edits. Related: [[ownership]].
`;

describe("lane-memory files", () => {
  it("parses the front matter Lane Pilot needs and maps it to a candidate", () => {
    const file = parseLaneMemoryFile(sample);
    expect(file).toMatchObject({ id: "worktree-routing", status: "active", sensitivity: "internal", contextPriority: "always", areas: ["procedures", "lanes"], hint: "worktree, параллельные полосы" });
    const mapped = laneMemoryFileToCandidate(file!);
    expect(mapped?.audience).toBe("subagent");
    expect(mapped?.candidate.kind).toBe("core");
    expect(mapped?.candidate.content.startsWith("Parallel writers use a worktree each")).toBe(true);
    expect(mapped?.candidate.concepts).toEqual(["worktree-routing", "procedures", "lanes", "worktree", "параллельные полосы"]);
  });

  it("reads block-style areas, skips inactive records and files without an id", () => {
    const block = sample.replace("  areas: [procedures, \"lanes\"]", "  areas:\n    - infra\n    - lanes").replace("status: active", "status: superseded");
    const file = parseLaneMemoryFile(block)!;
    expect(file.areas).toEqual(["infra", "lanes"]);
    expect(laneMemoryFileToCandidate(file)).toBeNull();
    expect(parseLaneMemoryFile("no front matter")).toBeNull();
    expect(parseLaneMemoryFile("---\nstatus: active\n---\nbody")).toBeNull();
  });

  it("renders a record as a schema-2 file that parses back", () => {
    const record = { id: "a".repeat(64), projectId: "p", personalBot: "", kind: "note" as const, content: "Night review found double discounts in checkout.\n\nFix: make applyDiscount idempotent.", concepts: ["lesson", "checkout"], sourceSha256: "b".repeat(64), createdAt: 0 };
    const text = renderLaneMemoryFile(record, "subagent", new Date("2026-09-30T00:00:00Z"));
    expect(exportedFileName(record)).toBe("lp-aaaaaaaaaaaaaaaa.md");
    const parsed = parseLaneMemoryFile(text)!;
    expect(parsed).toMatchObject({ id: "lp-aaaaaaaaaaaaaaaa", status: "active", sensitivity: "internal", contextPriority: "normal", areas: ["lesson", "checkout"] });
    expect(parsed.claim).toBe("Night review found double discounts in checkout.");
    expect(parsed.body).toBe("Fix: make applyDiscount idempotent.");
    for (const key of ["schema_version: 2", "memory_type: semantic", "truth_mode: observed", "language: en", "risk: low"]) expect(text).toContain(key);
  });
});
