import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAR_DRIVERS,
  CAR_IDS,
  CAR_NODE,
  CAR_SPOTS,
  DRIVE_MAX_X,
  DRIVE_MIN_X,
  advanceDriver,
} from "../src/rooms/council/ui/office-cars";

const GLB = readFileSync(new URL("../src/rooms/council/ui/assets/office-cars.glb", import.meta.url));

describe("office-cars.glb", () => {
  const jsonLength = GLB.readUInt32LE(12);
  const json = JSON.parse(GLB.subarray(20, 20 + jsonLength).toString("utf8")) as {
    nodes: Array<{ name: string; mesh?: number }>;
    meshes: Array<{ primitives: Array<{ indices: number }> }>;
    accessors: Array<{ count: number }>;
  };

  it("is a GLB under 1 MB", () => {
    expect(GLB.subarray(0, 4).toString()).toBe("glTF");
    expect(GLB.length).toBeLessThan(1_000_000);
  });

  it("has one single-mesh root per car, 1.5k-2.5k triangles each", () => {
    for (const id of CAR_IDS) {
      const node = json.nodes.find((n) => n.name === CAR_NODE[id]);
      expect(node?.mesh, id).toBeDefined();
      const mesh = json.meshes[node!.mesh!]!;
      expect(mesh.primitives).toHaveLength(1);
      const triangles = json.accessors[mesh.primitives[0]!.indices]!.count / 3;
      expect(triangles).toBeGreaterThanOrEqual(1500);
      expect(triangles).toBeLessThanOrEqual(2600);
    }
  });
});

describe("car spots and drivers", () => {
  it("park every car model once, apart from each other", () => {
    expect(CAR_SPOTS.map((s) => s.car).sort()).toEqual([...CAR_IDS].sort());
    for (const a of CAR_SPOTS) {
      for (const b of CAR_SPOTS) {
        if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(2.5);
      }
    }
  });

  it("loop the driving cars along the street", () => {
    for (const d of CAR_DRIVERS) {
      expect(CAR_IDS).toContain(d.car);
      expect(d.startX).toBeGreaterThanOrEqual(DRIVE_MIN_X);
      expect(d.startX).toBeLessThanOrEqual(DRIVE_MAX_X);
    }
    expect(advanceDriver(0, 3, 1)).toBeCloseTo(3);
    expect(advanceDriver(DRIVE_MAX_X - 1, 3, 1)).toBeCloseTo(DRIVE_MIN_X + 2);
  });
});
