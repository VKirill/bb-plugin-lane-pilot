import { describe, expect, it } from "vitest";
import { issueQuickModelCalls, issueQuickShortPath, issueQuickWorkflowId } from "../../src/rooms/workflow/short-path";
import { fileContaining } from "../support/source-text";

describe("issue_quick.short_path", () => {
  it("stays on the short path unless the setting is off", () => {
    expect(issueQuickShortPath(undefined)).toBe(true);
    expect(issueQuickShortPath({})).toBe(true);
    expect(issueQuickWorkflowId({ "issue_quick.short_path": "on" })).toBe("issue-quick");
    expect(issueQuickWorkflowId({ "issue_quick.short_path": "off" })).toBe("issue-quick-legacy");
    expect(issueQuickModelCalls({})).toBe(1);
    expect(issueQuickModelCalls({ "issue_quick.short_path": "off" })).toBe(2);
  });

  it("the intake starts the graph the setting names", () => {
    // The intake calls it wherever the intake lives now: the setting goes dead if the call does.
    expect(fileContaining("issueQuickWorkflowId(settings)").path).toMatch(/\.tsx?$/);
  });
});
