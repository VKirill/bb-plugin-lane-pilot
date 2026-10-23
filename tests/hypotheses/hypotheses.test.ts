import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { briefMode, briefParts } from "../../src/rooms/hypotheses";
import { createHypotheses, runHypothesisCli } from "../../src/rooms/hypotheses/server";
import { loadProjectSettings, openDatabase } from "../../src/rooms/storage/database";

describe("the writer's brief mode (SMA P2-11, contracts between roles)", () => {
  it("narrow keeps only the contract side: no memory, no rules, no PM read summary; full is the default", () => {
    const parts = { memory: "notes", rules: "rules", pmRead: "summary" };
    expect(briefMode({})).toBe("full");
    expect(briefMode({ "writer.brief_mode": "narrow" })).toBe("narrow");
    expect(briefParts("full", parts)).toEqual(parts);
    expect(briefParts("narrow", parts)).toEqual({ memory: "", rules: "", pmRead: "" });
  });
});

describe("the register of hypotheses (SMA P2-10)", () => {
  function world(verdict: "pass" | "fail") {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const runs: Array<{ arm: string; settings: unknown }> = [];
    const bench = {
      status: () => [{ version: "v2", createdAt: 1 }, { version: "v3", createdAt: 2 }],
      run: async (input: { arm: string; settings: unknown }) => { runs.push({ arm: input.arm, settings: input.settings }); return { started: true }; },
      compare: () => ({ comparison: { verdict }, text: `verdict ${verdict}` }),
    };
    const api = createHypotheses({ db, log: () => undefined } as never, { bench } as never).hypotheses;
    return { db, api, runs };
  }

  it("seeds the role-contracts hypothesis once, benches both arms on the newest set, and adopts a pass through the night policy", async () => {
    const { db, api, runs } = world("pass");
    expect(api.seed()).toBe(1);
    expect(api.seed()).toBe(0);
    expect(api.get("role-contracts")).toMatchObject({ state: "proposed", settings: { "writer.brief_mode": "narrow" } });
    expect(await api.test("role-contracts")).toMatchObject({ version: "v3" });
    expect(runs).toEqual([{ arm: "hyp-role-contracts-base", settings: {} }, { arm: "hyp-role-contracts", settings: { "writer.brief_mode": "narrow" } }]);
    expect(api.verdict("role-contracts")).toMatchObject({ state: "adopted" });
    expect(loadProjectSettings(db, "*")).toMatchObject({ "writer.brief_mode": "narrow" });
    expect(api.revert("role-contracts").state).toBe("rejected");
    expect(loadProjectSettings(db, "*")["writer.brief_mode"]).toBeUndefined();
  });

  it("a worse arm is rejected, and a model change that passes is held by the policy, never applied", async () => {
    const worse = world("fail");
    const id = worse.api.add({ title: "Faster critic", source: "https://example.org/post", settings: { "plan_critique.enabled": false } }).id;
    await worse.api.test(id);
    expect(worse.api.verdict(id)).toMatchObject({ state: "rejected" });
    const model = world("pass");
    const other = model.api.add({ title: "Another writer model", source: "a talk", settings: { "writer.model": "glm-6" } }).id;
    await model.api.test(other);
    expect(model.api.verdict(other)).toMatchObject({ state: "held" });
    expect(loadProjectSettings(model.db, "*")["writer.model"]).toBeUndefined();
  });

  it("the command line adds with settings and refuses what is missing", async () => {
    const { api } = world("pass");
    const added = JSON.parse((await runHypothesisCli(api, ["add", "--title", "Plan critic on", "--source", "repo X", "--setting", "plan_critique.enabled=true"])).stdout!);
    expect(added).toMatchObject({ state: "proposed", settings: { "plan_critique.enabled": true } });
    expect((await runHypothesisCli(api, ["add", "--title", "x", "--source", "y"])).stderr).toMatch(/names the settings/);
    expect((await runHypothesisCli(api, ["verdict", added.id])).stderr).toMatch(/has not been benched/);
    expect((await runHypothesisCli(api, ["nope"])).exitCode).toBe(1);
  });
});
