import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/** The starter graphs of the browser tools: browser-step (lane_pilot_browser) and lp.browser-qa (lane_pilot_browser_qa). */

describe("browser-step", () => {
  it("one goal, then the page it ends on", async () => {
    const r = await runSim("browser-step", { input: { url: "https://example.com/", goal: "Read the page title", changes: false }, stubs: { goal: { status: "done", hostId: "host_mini", url: "https://example.com/", actions: 1, title: "Example", text: "Example Domain" } } });
    expect(pathOf(r)).toBe("goal done");
    expect(out(r)).toMatchObject({ status: "done", url: "https://example.com/", actions: 1, text: "Example Domain" });
  });
});

describe("lp.browser-qa", () => {
  it("the check of an accepted task: its reply comes out as it is", async () => {
    const reply = { runId: "lprun_1", taskId: "t1", state: "failed", reason: "case 1 failed" };
    const r = await runSim("lp.browser-qa", { input: { run_id: "lprun_1", task_id: "t1", url: "http://127.0.0.1:5173/", cases: ["Open home"], env_class: "local" }, stubs: { qa: { state: "failed", reply } } });
    expect(pathOf(r)).toBe("qa done");
    expect(out(r)).toEqual({ state: "failed", reply });
  });
});
