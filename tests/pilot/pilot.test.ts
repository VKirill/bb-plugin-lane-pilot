import { describe, expect, it } from "vitest";
import { pilotOf } from "../../src/rooms/pilot";

describe("the pilot of an area", () => {
  const task = (id: string, area: string | null, kind: string | null, createdAt: number) => ({ id, area, kind, createdAt });
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
});
