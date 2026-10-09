import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { batchStatic } from "../src/batch";
import { createPropsKit } from "../src/props-kit";

function build() {
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose: () => void }> = [];
  const kit = createPropsKit({ THREE, scene, disposables });
  const group = new THREE.Group();
  group.position.set(3, 0, 4);
  group.rotation.y = Math.PI / 2;
  scene.add(group);
  kit.box(scene, 0, 1, 0, 1, 0, 1, 0xff0000);
  kit.box(scene, 2, 3, 0, 1, 0, 1, 0x00ff00);
  kit.box(group, 0, 1, 0, 1, 0, 1, 0x0000ff);
  kit.box(scene, 0, 1, 2, 3, 0, 1, 0xffffff, { opacity: 0.4 });
  kit.blob(scene, 5, 1, 5, 0.5, 0xff0000, 0.5);
  const car = new THREE.Group();
  car.userData.boxCar = true;
  car.position.set(10, 0, 10);
  scene.add(car);
  kit.box(car, -1, 1, 0, 1, -1, 1, 0x888888);
  return { scene, kit, group, car };
}

const bounds = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);

describe("batchStatic", () => {
  it("merges the static meshes into one opaque and one transparent mesh and keeps the isolated group apart", () => {
    const { scene, car } = build();
    const before = bounds(scene);
    const result = batchStatic(THREE, scene, { isolate: (o) => o.userData.boxCar === true });
    expect(result.sourceMeshes).toBe(6);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes.map((m) => m.name).sort()).toEqual(["batch:glass", "batch:opaque", "batch:opaque"]);
    expect(car.children.map((c) => c.name)).toEqual(["batch:opaque"]);
    // World bounds survive: groups were baked in, the isolated one kept its own transform
    const after = bounds(scene);
    expect(after.min.distanceTo(before.min)).toBeLessThan(1e-4);
    expect(after.max.distanceTo(before.max)).toBeLessThan(1e-4);
    // The group that held a mesh is gone
    expect(scene.children.filter((c) => c.type === "Group").length).toBe(1);
  });

  it("bakes the colour into vertex colours and the alpha of see-through boxes", () => {
    const { scene } = build();
    batchStatic(THREE, scene, { isolate: (o) => o.userData.boxCar === true });
    const glass = scene.getObjectByName("batch:glass") as THREE.Mesh;
    const color = glass.geometry.getAttribute("color");
    expect(color.itemSize).toBe(4);
    expect(color.getW(0)).toBeCloseTo(0.4);
    expect((glass.material as THREE.MeshToonMaterial).transparent).toBe(true);
    const opaque = scene.children.find((c) => c.name === "batch:opaque") as THREE.Mesh;
    expect(opaque.geometry.getAttribute("color").itemSize).toBe(3);
    expect((opaque.material as THREE.MeshToonMaterial).vertexColors).toBe(true);
    // the red box and the red ball: linear (1, 0, 0) is among the baked colours
    const colors = opaque.geometry.getAttribute("color");
    const reds = Array.from({ length: colors.count }, (_, i) => i).filter((i) => colors.getX(i) > 0.99 && colors.getY(i) < 0.01 && colors.getZ(i) < 0.01);
    expect(reds.length).toBeGreaterThan(24);
  });

  it("leaves skinned, textured and hidden meshes alone", () => {
    const scene = new THREE.Scene();
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshToonMaterial());
    hidden.visible = false;
    const flagged = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshToonMaterial());
    flagged.userData.noBatch = true;
    const lit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    scene.add(hidden, flagged, lit);
    const result = batchStatic(THREE, scene);
    expect(result.sourceMeshes).toBe(0);
    expect(scene.children).toHaveLength(3);
  });
});
