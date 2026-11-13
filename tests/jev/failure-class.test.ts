import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../src/rooms/contracts/failure-class";

const UNKNOWN = "ssh: connect to host 10.8.0.1 port 22: Operation timed out while syncing the worktree";

describe("failureClass: which reasons the rules are sure of", () => {
  it("is confident for every reason Lane Pilot writes and for a red check, and not for a message nobody has seen", () => {
    expect(classifyFailure("blocked", "internal_error: boom")).toEqual({ cls: "harness", confident: true });
    expect(classifyFailure("validation_failed", "verification failed (npm test): 2 failed")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("validation_failed", "writer changed paths outside owns_paths: src/a.ts")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("timeout", "wait timeout")).toEqual({ cls: "provider", confident: true });
    expect(classifyFailure("validation_failed", UNKNOWN)).toEqual({ cls: "task", confident: false });
    expect(classifyFailure("blocked", "needs_human: which account pays")).toEqual({ cls: "judgment", confident: true });
  });
});
