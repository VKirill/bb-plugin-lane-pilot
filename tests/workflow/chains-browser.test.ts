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
    const r = await runSim("lp.browser-qa", { input: { run_id: "lprun_1", task_id: "t1", url: "http://127.0.0.1:5173/", cases: ["Open home"], env_class: "local" }, stubs: { qa: { state: "failed", reply }, verdict: { state: "failed" } } });
    expect(pathOf(r)).toBe("qa verdict done");
    expect(out(r)).toEqual({ state: "failed", reply });
  });
});

describe("api-recon", () => {
  it("the crawl's map comes out as it is: paths, counts, whether there is an official API", async () => {
    const map = { status: "done", reason: "", report: "auth: JWT in localStorage", api_map: "artifacts/api-recon/api-map.md", endpoints: "artifacts/api-recon/endpoints.json", observed: 35, bundle_only: 83, official_api: false };
    const r = await runSim("api-recon", { input: { url: "https://shop.example.ru/", goal: "place orders from our system", account: "SHOP_LOGIN" }, stubs: { crawl: map } });
    expect(pathOf(r)).toBe("crawl done");
    expect(out(r)).toMatchObject({ status: "done", observed: 35, bundle_only: 83, official_api: false, api_map: map.api_map });
  });
});
