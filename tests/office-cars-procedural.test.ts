import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCar, CAR_MODELS, CAR_SIZES, type CarModel } from "../src/rooms/council/ui/office-cars-procedural";
import type { PropsKit } from "../src/rooms/council/ui/office-props-kit";

/** Just enough of the scene's prop kit: cached toon materials and world-bounds boxes. */
function makeKit(): PropsKit & { disposables: Array<{ dispose: () => void }> } {
  const materials = new Map<string, THREE.MeshToonMaterial>();
  const disposables: Array<{ dispose: () => void }> = [];
  const material = (color: number, opacity?: number) => {
    const key = `${color}:${opacity ?? 1}`;
    let mat = materials.get(key);
    if (!mat) {
      mat = new THREE.MeshToonMaterial({ color });
      materials.set(key, mat);
    }
    return mat;
  };
  const box = (parent: THREE.Object3D, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number) => {
    const geom = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    disposables.push(geom);
    const mesh = new THREE.Mesh(geom, material(color));
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    parent.add(mesh);
    return mesh;
  };
  return { THREE, scene: new THREE.Scene(), disposables, box, material, OUTLINE: 0x282a36, setPart: () => {} } as unknown as PropsKit & {
    disposables: Array<{ dispose: () => void }>;
  };
}

const sizeOf = (group: THREE.Object3D) => {
  const bounds = new THREE.Box3().setFromObject(group);
  return { bounds, size: bounds.getSize(new THREE.Vector3()) };
};

describe("procedural cars", () => {
  it("lists the seven models", () => {
    expect([...CAR_MODELS].sort()).toEqual(["cybertruck", "gwagon", "mustang", "p911", "raptor", "supercar", "vwbus"]);
  });

  for (const model of CAR_MODELS) {
    describe(model, () => {
      const kit = makeKit();
      const car = buildCar(kit, model as CarModel);
      const { bounds, size } = sizeOf(car);
      const [length, width, height] = CAR_SIZES[model];

      it("returns a group of a modest number of meshes", () => {
        expect(car).toBeInstanceOf(THREE.Group);
        let meshes = 0;
        car.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) meshes++;
        });
        expect(meshes).toBeGreaterThan(10);
        expect(meshes).toBeLessThanOrEqual(60);
        expect(kit.disposables.length).toBeGreaterThan(0);
      });

      it("matches the target size within 15 percent", () => {
        expect(size.z).toBeGreaterThan(length * 0.85);
        expect(size.z).toBeLessThan(length * 1.15);
        expect(size.x).toBeGreaterThan(width * 0.85);
        expect(size.x).toBeLessThan(width * 1.15);
        expect(size.y).toBeGreaterThan(height * 0.85);
        expect(size.y).toBeLessThan(height * 1.15);
      });

      it("stands on y = 0 and is centred on the origin", () => {
        expect(Math.abs(bounds.min.y)).toBeLessThan(0.02);
        expect(Math.abs((bounds.min.x + bounds.max.x) / 2)).toBeLessThan(0.05);
        expect(Math.abs((bounds.min.z + bounds.max.z) / 2)).toBeLessThan(0.45);
      });

      it("has four wheels on the ground, the front axle toward +Z", () => {
        const wheels = car.userData.wheels as THREE.Object3D[];
        expect(wheels).toHaveLength(4);
        for (const wheel of wheels) {
          expect(wheel.parent).toBe(car);
          const wb = new THREE.Box3().setFromObject(wheel);
          expect(Math.abs(wb.min.y)).toBeLessThan(0.02);
        }
        expect(wheels[0]!.position.z).toBeGreaterThan(0);
        expect(wheels[1]!.position.z).toBeLessThan(0);
        expect(wheels[0]!.position.x).toBeCloseTo(-wheels[2]!.position.x, 5);
      });

      it("rolls its wheels about x", () => {
        const wheel = (car.userData.wheels as THREE.Object3D[])[0]!;
        const before = new THREE.Box3().setFromObject(wheel).getSize(new THREE.Vector3());
        wheel.rotation.x = 1.2;
        const after = new THREE.Box3().setFromObject(wheel).getSize(new THREE.Vector3());
        wheel.rotation.x = 0;
        expect(after.x).toBeCloseTo(before.x, 2);
        expect(after.y).toBeGreaterThan(0.5 * before.y);
      });
    });
  }
});
