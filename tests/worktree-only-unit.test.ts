import { describe, expect, it } from "vitest";
import { parseWorkspaceMode, resolveAttemptWorkspace } from "../src/workspace/routing";

describe("worktree-only unit tests", () => {
  it("parses legacy in_place and Russian label as auto", () => {
    expect(parseWorkspaceMode("in_place")).toBe("auto");
    expect(parseWorkspaceMode("В папке проекта")).toBe("auto");
    expect(parseWorkspaceMode("auto")).toBe("auto");
    expect(parseWorkspaceMode("worktree")).toBe("worktree");
    expect(parseWorkspaceMode(undefined)).toBe("auto");
    expect(parseWorkspaceMode("")).toBe("auto");
  });

  it("gives a Lane chat's attempt its own worktree at minScore 0 even when the project said in_place", () => {
    for (const risk of ["low", "medium", "high", "critical"]) {
      expect(resolveAttemptWorkspace({ mode: parseWorkspaceMode("in_place"), risk, expectedOutputCount: 1, minScore: 0, multiWriteEnabled: false }))
        .toMatchObject({ strategy: "provision_attempt_worktree" });
    }
  });
});
