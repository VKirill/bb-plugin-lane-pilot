import { describe, expect, it } from "vitest";
import fixture from "../fixtures/vampirism-fire-run.json";
import { pilotOf } from "../../src/rooms/pilot";

describe("the pilot of an area", () => {
  const task = (id: string, area: string | null, kind: string | null, createdAt: number, dependsOn: string[] = []) => ({ id, area, kind, createdAt, dependsOn });
  it("is the first sibling of three or more of one area and kind; the pilot itself and a small group wait for no one", () => {
    const tasks = [task("b", "page:/x", "feature", 2), task("a", "page:/x", "feature", 1), task("c", "page:/x", "feature", 3), task("d", "page:/x", "fix", 4), task("e", null, null, 0)];
    expect(pilotOf("b", tasks)).toBe("a");
    expect(pilotOf("c", tasks)).toBe("a");
    expect(pilotOf("a", tasks)).toBeNull();
    expect(pilotOf("d", tasks)).toBeNull();
    expect(pilotOf("e", tasks)).toBeNull();
    expect(pilotOf("b", tasks.slice(0, 2))).toBeNull();
    expect(pilotOf("missing", tasks)).toBeNull();
  });

  it("never adds a pilot to a task the PM ordered, and picks a pilot that depends on nothing (no wait cycle)", () => {
    const chain = [task("b", "page:/x", "feature", 1, ["c"]), task("c", "page:/x", "feature", 2, ["a"]), task("a", "page:/x", "feature", 3)];
    expect(pilotOf("a", chain)).toBeNull();
    expect(pilotOf("b", chain)).toBeNull();
    expect(pilotOf("c", chain)).toBeNull();
    const mixed = [task("b", "page:/x", "feature", 1, ["z"]), task("a", "page:/x", "feature", 2), task("d", "page:/x", "feature", 3)];
    expect(pilotOf("d", mixed)).toBe("a");
  });
});

describe("a task sent again is one sibling", () => {
  it("the redos of a blocked task never make it its own pilot (Vampirism Fire vf-t0-test-infra.3, 2026-10-23)", () => {
    const t = (id: string, createdAt: number) => ({ id, area: "game:test-infra", kind: "chore", createdAt, dependsOn: [] as string[] });
    const tasks = [t("vf-t0-test-infra", 1), t("vf-t0-test-infra.2", 2), t("vf-t0-test-infra.3", 3)];
    expect(pilotOf("vf-t0-test-infra.3", tasks)).toBeNull();
    expect(pilotOf("vf-t0-test-infra.2", tasks)).toBeNull();
    const siblings = [...tasks, t("vf-other-a", 4), t("vf-other-b", 5)];
    expect(pilotOf("vf-other-b", siblings)).toBe("vf-t0-test-infra");
    expect(pilotOf("vf-t0-test-infra.3", siblings)).toBeNull();
  });
});

describe("the pilot of a shared resource", () => {
  const MIN = 60_000;
  const t = (id: string, minutes: number, ownsPaths: string[], extra: Partial<{ dependsOn: string[]; canceled: boolean; area: string | null; kind: string | null }> = {}) =>
    ({ id, area: null, kind: null, createdAt: minutes * MIN, dependsOn: [] as string[], ownsPaths, ...extra });
  const wave = [t("a", 0, ["scripts/gamedata/"]), t("b", 1, ["scripts/gamedata/rules.py", "game/b.luau"]), t("c", 2, ["scripts/gamedata/"]), t("d", 2, ["game/d.luau"])];

  it("makes the first of three tasks that share owns_paths the pilot; the others wait for it and a task of its own files does not", () => {
    expect(pilotOf("b", wave)).toBe("a");
    expect(pilotOf("c", wave)).toBe("a");
    expect(pilotOf("a", wave)).toBeNull();
    expect(pilotOf("d", wave)).toBeNull();
  });

  it("needs three sharing tasks, dispatched within 30 minutes of each other (a chain of overlaps counts as one wave)", () => {
    expect(pilotOf("b", wave.slice(0, 2))).toBeNull();
    expect(pilotOf("c", [t("a", 0, ["x/"]), t("b", 20, ["x/", "y/"]), t("c", 45, ["y/"])])).toBe("a");
    expect(pilotOf("c", [t("a", 0, ["x/"]), t("b", 20, ["x/"]), t("c", 49, ["x/"])])).toBe("a");
    expect(pilotOf("c", [t("a", 0, ["x/"]), t("b", 20, ["x/"]), t("c", 51, ["x/"])])).toBeNull();
    expect(pilotOf("d", [t("a", 0, ["x/"]), t("b", 40, ["x/"]), t("c", 62, ["x/"]), t("d", 65, ["x/"])])).toBe("b");
    expect(pilotOf("c", [t("a", 0, ["x/"]), t("b", 10, ["x/"]), t("c", 200, ["x/"])])).toBeNull();
  });

  it("leaves out tasks the PM ordered, canceled ones and tasks without owns_paths, and counts a task sent again once", () => {
    expect(pilotOf("c", wave.map((task) => (task.id === "a" ? { ...task, canceled: true } : task)))).toBeNull();
    expect(pilotOf("c", [...wave.map((task) => (task.id === "a" ? { ...task, canceled: true } : task)), t("e", 3, ["scripts/gamedata/"])])).toBe("b");
    expect(pilotOf("c", wave.map((task) => (task.id === "b" ? { ...task, dependsOn: ["a"] } : task)))).toBeNull();
    expect(pilotOf("c", wave.map(({ ownsPaths, ...task }) => task))).toBeNull();
    const again = [...wave, t("c.2", 90, ["scripts/gamedata/"]), t("a.2", 91, ["scripts/gamedata/"])];
    expect(pilotOf("c.2", again)).toBe("a");
    expect(pilotOf("a.2", again)).toBeNull();
    expect(pilotOf("c.2", [t("a", 0, ["x/"]), t("c", 1, ["x/"]), t("c.2", 90, ["x/"])])).toBeNull();
  });

  it("keeps the area-and-kind pilot first, and no task waits for a later one", () => {
    const sibling = (id: string, minutes: number) => ({ id, area: "page:/x", kind: "feature", createdAt: minutes * MIN, dependsOn: [] as string[], ownsPaths: [`${id}/`] });
    const siblings = [sibling("p", 0), sibling("q", 1), sibling("r", 2)];
    expect(pilotOf("r", siblings)).toBe("p");
    const mixed = [...wave, ...siblings.map((task) => ({ ...task, ownsPaths: ["scripts/gamedata/"] }))];
    for (const task of mixed) {
      const pilot = pilotOf(task.id, mixed);
      if (pilot) expect(mixed.find((other) => other.id === pilot)!.createdAt).toBeLessThanOrEqual(task.createdAt);
    }
  });
});

describe("the pilot of a shared resource, replayed over Vampirism Fire", () => {
  type Row = { id: string; at: number; kind: string; area: string; files: string[] };
  /** The PM's own tasks as runTasks reads them (a mainfix is not part of a wave); a redo is the same task sent again. */
  const tasks = (fixture as { tasks: Row[] }).tasks.filter((row) => !/-mainfix(\.\d+)*$/.test(row.id))
    .map((row) => ({ id: row.id, area: row.area, kind: row.kind, createdAt: row.at, dependsOn: [] as string[], ownsPaths: row.files }));
  const firsts = tasks.filter((task) => !/\.\d+$/.test(task.id));
  const withoutPaths = tasks.map(({ ownsPaths, ...task }) => task);
  const held = (list: typeof tasks | typeof withoutPaths) => Object.fromEntries(firsts.flatMap((task) => { const pilot = pilotOf(task.id, list); return pilot ? [[task.id, pilot]] : []; }));
  const now = held(tasks), before = held(withoutPaths);

  it("puts the first task of each wave that shares files in front of the rest, which the area-and-kind rule alone did not", () => {
    expect(Object.keys(before)).toHaveLength(14);
    expect(Object.keys(now)).toHaveLength(46);
    expect(Object.entries(before).every(([id, pilot]) => now[id] === pilot)).toBe(true);
    // Test infrastructure first, then the economy mechanics that all patch the same Luau files and the one Studio.
    for (const id of ["vf-s0-items-core", "vf-s0-damage", "vf-s1-xp", "vf-s1-minute-eco", "vf-s1-round", "vf-s1-regen", "vf-s0-data"]) expect(now[id]).toBe("vf-t0-test-infra");
    for (const id of ["vf-s2-accounting", "vf-s2-repair", "vf-s2-outpost", "vf-s2-base-control", "vf-s2-trees"]) expect(now[id]).toBe("vf-s2-requirements");
    for (const id of ["vf-s4-altar", "vf-s4-portals", "vf-s4-archangel"]) expect(now[id]).toBe("vf-s4-spells-a");
    for (const id of ["vf-s5-shops", "vf-s5-shop-sites", "vf-s5-shop-ui"]) expect(now[id]).toBe("vf-s5-inventory");
    for (const id of ["vf-s6-auras", "vf-s6-slayer-pit", "vf-s6-towers", "vf-s6-world"]) expect(now[id]).toBe("vf-s6-vision");
    for (const id of ["vf-s7-restock", "vf-s7-sacrificial", "vf-s7-small-fixes"]) expect(now[id]).toBe("vf-s7-minion-aura");
    for (const id of ["vf-fix-b1-world", "vf-fix-b1-towers", "vf-fix-b2-range", "vf-fix-b2-towers", "vf-fix-b2-flow"]) expect(now[id]).toBe("vf-fix-b1-shops");
  });

  it("does not hold independent mechanics that own different files, nor the first task of a wave", () => {
    for (const id of ["vf-s3-lobby", "vf-s3-commands", "vf-s3-board", "vf-rf-data", "vf-rf-items-eco", "vf-rf-vampires-flow", "vf-s4-centers", "vf-s7-cosmetics", "vf-audit-tests-a", "vf-audit-tests-b", "vf-audit-tests-c"]) expect(now[id]).toBeUndefined();
    for (const id of ["vf-t0-test-infra", "vf-s2-requirements", "vf-s4-spells-a", "vf-s5-inventory", "vf-s6-vision", "vf-s7-minion-aura", "vf-fix-b1-shops"]) expect(now[id]).toBeUndefined();
  });

  it("never makes two tasks wait for each other: every wait points at an earlier task", () => {
    const at = new Map(tasks.map((task) => [task.id, task.createdAt]));
    for (const task of tasks) {
      const seen = new Set<string>();
      for (let id: string | null = task.id; id; id = pilotOf(id, tasks)) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      const pilot = pilotOf(task.id, tasks);
      if (pilot) expect(at.get(pilot)!).toBeLessThanOrEqual(task.createdAt);
    }
  });
});
