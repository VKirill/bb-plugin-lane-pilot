import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { issueQuickModelCalls, issueQuickShortPath, issueQuickWorkflowId } from "../../src/rooms/workflow/short-path";

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
    const driver = readFileSync(new URL("../../src/rooms/phase/server/driver.ts", import.meta.url), "utf8");
    expect(driver).toContain("issueQuickWorkflowId(settings)");
  });
});
