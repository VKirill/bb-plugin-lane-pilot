import { describe, expect, it } from "vitest";
import { DRILL_SANDBOX_PROJECT_IDS, isSandboxProjectName } from "../src/rooms/contracts";
import { isSandboxProject } from "../src/rooms/owner-waiting/items";
import { isTestProject } from "../src/rooms/pages/service-projects";

describe("one sandbox rule", () => {
  it("owner-waiting knows every drill sandbox id before the first canary tick", () => {
    // Bug fixed: the seed had only the Mac mini id; the OVH drill was a real project until the canary ran.
    for (const id of DRILL_SANDBOX_PROJECT_IDS) expect(isSandboxProject(id), id).toBe(true);
  });

  it("service-projects files every drill id and sandbox-name project under Service", () => {
    expect(isTestProject({ id: "proj_ibu6v9g64j", name: "LP sandbox OVH (drill)" })).toBe(true);
    expect(isTestProject({ id: "proj_other", name: "LP bench SelfyStudio" })).toBe(true);
    // Bug fixed: a project named «LP test …» is a working project — the canary counts its failures, the page must too.
    expect(isTestProject({ id: "proj_x", name: "LP test playground" })).toBe(false);
    expect(isTestProject({ id: "proj_x", name: "SelfyStudio" })).toBe(false);
  });

  it("the page's service split and the canary's scope agree on a name", () => {
    expect(isTestProject({ id: "p", name: "LP native smoke" })).toBe(isSandboxProjectName("LP native smoke"));
  });
});
