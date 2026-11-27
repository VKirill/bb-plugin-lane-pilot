import { describe, expect, it } from "vitest";
import { activationDisabledPredicate, composerButtonDisabled } from "../src/rooms/native-agent/models/activation";

describe("composer activation", () => {
  it.each(["setup_required", "ambiguous", "offline", "catalog_unavailable"])("defers %s project binding to native dispatch only in mention mode", (bindingStatus) => {
    expect(activationDisabledPredicate({ projectId: "clients", bindingStatus, launchMode: "mention" })).toEqual([]);
    expect(activationDisabledPredicate({ projectId: "clients", bindingStatus, launchMode: "spawn", nativeSelectionReady: true })).toEqual([{ code: "need_binding", detail: bindingStatus }]);
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
    const mentionReady = activationDisabledPredicate({
      projectId: "proj_a",
      bindingStatus: "resolved",
      launchMode: "mention",
    });
    expect(mentionReady).toEqual([]);
    expect(composerButtonDisabled(selectedReady)).toBe(false);
    const pending = activationDisabledPredicate({ pending: true, projectId: "proj_a" });
    expect(composerButtonDisabled(pending)).toBe(true);
  });
});
