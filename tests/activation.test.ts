import { describe, expect, it } from "vitest";
import { activationDisabledPredicate, classifyComposerSession, composerButtonDisabled } from "../src/activation";

describe("composer activation", () => {
  it("classifies new-thread, unstarted, ordinary started, and LP-active sessions", () => {
    expect(classifyComposerSession({ composerKind: "new-thread", threadId: null })).toBe("new-thread");
    expect(classifyComposerSession({ composerKind: "thread", threadId: "thr_1" })).toBe("unstarted-thread");
    expect(classifyComposerSession({ composerKind: "thread", threadId: "thr_1", threadStatus: "active" })).toBe("ordinary-started");
    expect(classifyComposerSession({ composerKind: "thread", threadId: "thr_1", pluginRole: "pm" })).toBe("lp-active");
  });

  it("disables the Enable button only while pending, for no-project and selected-project", () => {
    const missingProject = activationDisabledPredicate({ projectId: null, projectCount: 2 });
    expect(missingProject.map((row) => row.code)).toEqual(["need_project", "need_composer_selection"]);
    expect(composerButtonDisabled(missingProject)).toBe(false);
    const selectedUnread = activationDisabledPredicate({ projectId: "proj_a", bindingStatus: "resolved" });
    expect(selectedUnread.map((row) => row.code)).toEqual(["need_composer_selection"]);
    expect(composerButtonDisabled(selectedUnread)).toBe(false);
    const selectedReady = activationDisabledPredicate({
      projectId: "proj_a",
      bindingStatus: "resolved",
      nativeSelectionReady: true,
    });
    expect(selectedReady).toEqual([]);
    expect(composerButtonDisabled(selectedReady)).toBe(false);
    const pending = activationDisabledPredicate({ pending: true, projectId: "proj_a" });
    expect(composerButtonDisabled(pending)).toBe(true);
  });
});
