import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserQaInputSchema, browserQaVerdict, runBrowserQaOnHost } from "../../src/stages/browser-qa";

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
    expect(browserQaVerdict("Total / Passed / Failed / Blocked: 1 / 1 / 0 / 0", 0)).toBe("passed");
    expect(browserQaVerdict("Total / Passed / Failed / Blocked: 2 / 1 / 0 / 0", 0)).toBe("blocked");
    expect(browserQaVerdict("Total / Passed / Failed / Blocked / Pending: 2 / 1 / 1 / 0 / 0", 0)).toBe("failed");
    expect(browserQaVerdict("Total / Passed / Failed / Blocked / Pending: 2 / 1 / 0 / 1 / 0", 0)).toBe("blocked");
    expect(browserQaVerdict("report without a parseable summary", 0)).toBe("blocked");
    expect(browserQaVerdict("Total / Passed / Failed / Blocked / Pending: 2 / 2 / 0 / 0 / 0", 1)).toBe("failed");
  });

  it("requires explicit authorization for stateful actions described in Russian", async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), "lane-pilot-browser-qa-"));
    try {
      await expect(runBrowserQaOnHost({
        requestedHostId:"host-test", projectCwd, url:"http://127.0.0.1:5173/", slug:"lp-qa-test",
        cases:["Удалить тестовую запись"], envClass:"local", viewports:"375,1280", authorized:false,
        provider:"jev", backend:"chrome-qa", timeoutSec:900,
      })).rejects.toThrow("browser_qa_requires_explicit_authorization_for_target_or_side_effect");
    } finally {
      await rm(projectCwd,{recursive:true,force:true});
    }
  });
});
