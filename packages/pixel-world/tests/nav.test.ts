import { describe, expect, it } from "vitest";
import { createNavGrid, type NavRect } from "../src/nav";

const bounds: NavRect = { minX: -10, maxX: 10, minZ: -5, maxZ: 5 };
// A wall across the room with a gap at the top, and a pillar
const obstacles: NavRect[] = [
  { minX: -0.2, maxX: 0.2, minZ: -5, maxZ: 3 },
  { minX: 5, maxX: 6, minZ: -1, maxZ: 1 },
];

/** The scan every query used to be: every rectangle, every time. */
const brute = (x: number, z: number, margin: number) =>
  x < bounds.minX + margin || x > bounds.maxX - margin || z < bounds.minZ + margin || z > bounds.maxZ - margin ||
  obstacles.some((r) => x >= r.minX - margin && x <= r.maxX + margin && z >= r.minZ - margin && z <= r.maxZ + margin);

describe("createNavGrid", () => {
  const nav = createNavGrid({ bounds, obstacles });

  it("answers point queries exactly like a scan over all rectangles, for any margin", () => {
    for (let x = -11; x <= 11; x += 0.13) {
      for (let z = -6; z <= 6; z += 0.17) {
        for (const margin of [0, 0.08, 0.15, 0.6]) expect(nav.isBlocked(x, z, margin)).toBe(brute(x, z, margin));
      }
    }
  });

  it("walks straight when nothing is in the way", () => {
    expect(nav.findPath({ x: -8, z: -3 }, { x: -2, z: -3 })).toEqual([{ x: -2, z: -3 }]);
  });

  it("goes around a wall through the gap, never through a blocked point", () => {
    const start = { x: -5, z: -3 };
    const target = { x: 5, z: -3 };
    expect(nav.isSegmentBlocked(start.x, start.z, target.x, target.z)).toBe(true);
    const path = nav.findPath(start, target);
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toEqual(target);
    let from = start;
    for (const step of path) {
      expect(nav.isSegmentBlocked(from.x, from.z, step.x, step.z)).toBe(false);
      from = step;
    }
  });

  it("snaps a target inside an obstacle to a free cell nearby", () => {
    const path = nav.findPath({ x: 8, z: 3 }, { x: 5.5, z: 0 });
    expect(path.length).toBeGreaterThan(0);
  });
});
