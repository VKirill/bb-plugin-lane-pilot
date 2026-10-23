import { describe, expect, it } from "vitest";
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
