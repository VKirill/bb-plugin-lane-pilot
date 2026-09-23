import { describe, expect, it } from "vitest";
import { browserQaInputSchema, browserQaVerdict } from "../../src/stages/browser-qa";

describe("browser QA host stage contract", () => {
  it("requires a bounded, concrete browser run request", () => {
    expect(browserQaInputSchema.safeParse({
      requestedHostId:"host-test", projectCwd:"/tmp/project", url:"http://127.0.0.1:5173/", slug:"lp-qa-test",
      cases:["Open the home page and verify its title"], envClass:"local", viewports:"375,1280", authorized:false,
      provider:"jev", backend:"chrome-qa", timeoutSec:900,
    }).success).toBe(true);
    expect(browserQaInputSchema.safeParse({
      requestedHostId:"host-test", projectCwd:"/tmp/project", url:"file:///etc/passwd", slug:"../unsafe",
      cases:[], envClass:"production", viewports:"375,1280", authorized:false,
      provider:"jev", backend:"chrome-qa", timeoutSec:900,
    }).success).toBe(false);
  });

  it("passes only a complete all-passed report and fails closed for every other summary", () => {
    expect(browserQaVerdict("Total / Passed / Failed / Blocked / Pending: 2 / 2 / 0 / 0 / 0", 0)).toBe("passed");
    expect(browserQaVerdict("Total / Passed / Failed / Blocked / Pending: 2 / 1 / 1 / 0 / 0", 0)).toBe("failed");
    expect(browserQaVerdict("Total / Passed / Failed / Blocked / Pending: 2 / 1 / 0 / 1 / 0", 0)).toBe("blocked");
    expect(browserQaVerdict("report without a parseable summary", 0)).toBe("blocked");
    expect(browserQaVerdict("Total / Passed / Failed / Blocked / Pending: 2 / 2 / 0 / 0 / 0", 1)).toBe("failed");
  });
});
