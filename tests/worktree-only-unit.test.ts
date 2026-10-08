import { describe, expect, it } from "vitest";
import { parseWorkspaceMode, resolveAttemptWorkspace } from "../src/rooms/verification/routing";

describe("worktree-only unit tests", () => {
  it("parses legacy in_place and Russian label as auto", () => {
    expect(parseWorkspaceMode("in_place")).toBe("auto");
    expect(parseWorkspaceMode("В папке проекта")).toBe("auto");
    expect(parseWorkspaceMode("auto")).toBe("auto");
    expect(parseWorkspaceMode("worktree")).toBe("worktree");
    expect(parseWorkspaceMode(undefined)).toBe("auto");
    expect(parseWorkspaceMode("")).toBe("auto");
  });

  it("gives every attempt its own worktree, whatever the risk, the threshold or a saved in_place", () => {
    for (const risk of ["low", "medium", "high", "critical"]) {
      for (const minScore of [0, 4, 10]) {
        expect(resolveAttemptWorkspace({ mode: parseWorkspaceMode("in_place"), risk, expectedOutputCount: 1, minScore, multiWriteEnabled: false }))
          .toMatchObject({ strategy: "provision_attempt_worktree" });
      }
    }
  });
});
