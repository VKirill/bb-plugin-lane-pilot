import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unlistedSnapshot } from "../scripts/sma-settings-snapshot";
import { DRILL_SANDBOX_PROJECT_IDS } from "../src/rooms/contracts/project-scope";
import { SMA_EVIDENCE } from "../src/rooms/sma-map/evidence";
import { entry, isSet, not, type ReachSpec, via } from "../src/rooms/sma-map/evidence/types";
import { SMA_LINKS, SMA_NODES } from "../src/rooms/sma-map/graph";
import { evaluateReach, needHolds, settingReads, undeclaredGates } from "../src/rooms/sma-map/reach";
import { SMA_DRILL_PROJECTS, defaultSettings, hubSettings, overlay, settingRegistry, settingWord } from "../src/rooms/sma-map/settings-registry";

const root = join(import.meta.dirname, "..");
type Node = readonly [string, number, string, string, string];
type Link = readonly [string, string, string, string];
const node = (id: string, kind = "step"): Node => [id, 0, "fixture", kind, id];
const offSwitch = () => [...settingRegistry().values()].find((info) => info.switchLike && info.default === "off")!.key;
const reach = (nodes: Node[], links: Link[], specs: Record<string, ReachSpec>, settings = defaultSettings()) => evaluateReach(nodes, links, (id) => specs[id], settings);

describe("reachability under the effective settings (sma-parity-tz.md §4.3)", () => {
  it("a node gated by a default-off setting is unreachable, and so is everything only it leads to", () => {
    const gate = offSwitch();
    const out = reach([node("a"), node("b"), node("c")], [["a", "b", "transition", ""], ["b", "c", "calls", ""]], { a: entry("a task arrives"), b: via({ [gate]: "on" }) });
    expect(out.get("a")!.reachable).toBe(true);
    expect(out.get("b")).toMatchObject({ reachable: false, why: expect.stringContaining(`needs fail: ${gate}=off`) });
    expect(out.get("c")).toMatchObject({ reachable: false, why: expect.stringContaining("no reachable predecessor (b)") });
  });

  it("a node with no entry and no control predecessor is unreachable; a passive store is reached when a reachable step writes it", () => {
    const out = reach([node("a"), node("lone"), node("db", "store"), node("doc", "document")], [["a", "db", "writes", ""], ["lone", "doc", "writes", ""]], { a: entry("the nightly schedule") });
    expect(out.get("lone")).toMatchObject({ reachable: false, why: "no entry and no control predecessor" });
    expect(out.get("db")).toMatchObject({ reachable: true, why: "touched by a" });
    expect(out.get("doc")).toMatchObject({ reachable: false, why: "no reachable node writes, reads or shows it" });
  });

  it("a data link does not carry reachability between steps; a gate lets work through to what it guards", () => {
    const out = reach([node("a"), node("b"), node("g", "gate"), node("c")], [["a", "b", "reads", ""], ["a", "g", "calls", ""], ["g", "c", "guards", ""]], { a: entry("x") });
    expect(out.get("b")!.reachable).toBe(false);
    expect(out.get("c")!.reachable).toBe(true);
  });

  it("needs compare folded words: on/off spellings, a list, not(...), isSet()", () => {
    expect(needHolds("on", settingWord("true"))).toBe(true);
    expect(needHolds(["strict", "warn"], "warn")).toBe(true);
    expect(needHolds(not("off"), undefined)).toBe(true);
    expect(needHolds(not(["off", "observe"]), "observe")).toBe(false);
    expect(needHolds(isSet(), undefined)).toBe(false);
    expect(needHolds(isSet(), "500000")).toBe(true);
  });

  it("the hub's global rows lie over the defaults and an active project's rows over those; drill sandboxes are left out", () => {
    const gate = offSwitch();
    const db = {
      prepare: (sql: string) => ({
        all: () => sql.includes("lane_pilot_project_settings")
          ? [{ projectId: "*", key: gate, value: "true" }, { projectId: "proj_a", key: gate, value: "\"off\"" }, { projectId: SMA_DRILL_PROJECTS[0], key: gate, value: "false" }]
          : [{ projectId: "proj_a", tasks: 9 }, { projectId: "proj_b", tasks: 3 }, { projectId: SMA_DRILL_PROJECTS[0], tasks: 50 }],
      }),
    };
    const hub = hubSettings(db, 0);
    expect(hub.global.get(gate)).toBe("on");
    expect(hub.projects.map((project) => [project.projectId, project.overrides, project.settings.get(gate)])).toEqual([["proj_a", 1, "off"], ["proj_b", 0, "on"]]);
    const specs = { a: entry("x"), b: via({ [gate]: "on" }) };
    const nodes = [node("a"), node("b")];
    const links: Link[] = [["a", "b", "transition", ""]];
    expect(reach(nodes, links, specs, hub.global).get("b")!.reachable).toBe(true);
    expect(reach(nodes, links, specs, hub.projects[0]!.settings).get("b")!.reachable).toBe(false);
  });

  it("keeps the drill sandbox list and the unlisted-switch copy equal to the settings room's", () => {
    expect([...SMA_DRILL_PROJECTS].sort()).toEqual([...DRILL_SANDBOX_PROJECT_IDS].sort());
    expect(readFileSync(join(root, "src/rooms/sma-map/unlisted-switches.json"), "utf8")).toBe(unlistedSnapshot());
  });

  it("names an undeclared gate: a switch the node's function reads, off by default, that needs does not declare", () => {
    const gate = offSwitch();
    expect(undeclaredGates([gate, "no.such"], undefined, defaultSettings())).toEqual([gate]);
    expect(undeclaredGates([gate], via({ [gate]: "on" }), defaultSettings())).toEqual([]);
    expect(undeclaredGates([gate], { notGatedBy: { [gate]: "only picks the wording" } }, defaultSettings())).toEqual([]);
    expect(undeclaredGates([gate], undefined, overlay(defaultSettings(), [{ key: gate, value: "true" }]))).toEqual([]);
  });

  it("reads the setting keys a proof's function names, following re-exports", () => {
    const reads = settingReads(root, "src/rooms/contracts/failure-class.ts#failureClassCooldownMs");
    expect(reads).toEqual(expect.arrayContaining(["writer.class_cooldowns", "writer.cooldown_max_ms"]));
    expect(settingReads(root, "lane-stack:hooks/x.py#y")).toBeNull();
  });

  it("evaluates the real map: entries reach their successors, and a node with neither stays out", () => {
    const out = evaluateReach(SMA_NODES, SMA_LINKS, () => undefined, defaultSettings());
    expect([...out.values()].every((result) => !result.reachable)).toBe(true);
    const seeded = evaluateReach(SMA_NODES, SMA_LINKS, (id) => (id === "n300" ? entry("a task is enqueued") : undefined), defaultSettings());
    expect(seeded.get("n300")!.reachable).toBe(true);
    expect([...seeded.values()].filter((result) => result.reachable).length).toBeGreaterThan(1);
  });

  it("UR-01/UR-02: paid-cap and post-optional plan/draw nodes stay reachable while their own dormant gates stay closed", () => {
    const dormant = overlay(defaultSettings(), ["money.strict", "money.task_ceiling", "phase.research", "phase.validation", "phase.pattern_map", "phase.draw_material", "phase.plan_bounce", "phase.doc_files", "phase.commit_docs"].map((key) => ({ key, value: "off" })));
    const reach = (settings: ReturnType<typeof overlay>) => evaluateReach(SMA_NODES, SMA_LINKS, (id) => SMA_EVIDENCE[id]?.reach, settings);
    const out = reach(dormant);
    for (const id of ["n635", "n636", "n638", "n639", "n640", "n643", "n1158", "n1159", "n1263", "n1264", "n1265", "n1267", "n1268", "n1269", "n1271", "n1272", "n1273", "n1275", "n1400", "n1401"])
      expect(out.get(id), id).toMatchObject({ reachable: true });
    for (const id of ["n633", "n641", "n1157", "n1261", "n1262", "n1266", "n1641", "n1270", "n1274"])
      expect(out.get(id), id).toMatchObject({ reachable: false });
    const strict = overlay(dormant, [{ key: "money.strict", value: "on" }]);
    expect(reach(strict).get("n633")).toMatchObject({ reachable: true });
    const gated = ["phase.plan_bounce", "phase.doc_files", "phase.commit_docs"].map((key) => ({ key, value: "on" }));
    const allOn = overlay(dormant, gated);
    expect(reach(allOn).get("n1270")).toMatchObject({ reachable: true });
    expect(reach(allOn).get("n1274")).toMatchObject({ reachable: true });
    for (const off of ["phase.plan_bounce", "phase.doc_files", "phase.commit_docs"]) {
      const settings = overlay(allOn, [{ key: off, value: "off" }]);
      expect(reach(settings).get(off === "phase.plan_bounce" ? "n1270" : "n1274"), off).toMatchObject({ reachable: false });
      if (off !== "phase.plan_bounce") expect(reach(settings).get("n1270"), off).toMatchObject({ reachable: true });
    }
  });
});
