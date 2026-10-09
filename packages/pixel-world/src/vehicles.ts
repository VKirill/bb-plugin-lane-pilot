/**
 * Stylised cars (office-cars.glb): single-mesh models on the scene's toon gradient. Model space: metres, ground at
 * y = 0, centred on x/z, the front faces +Z (see assets/world/office-cars.md).
 */
import type * as ThreeNS from "three";
import { loadModel, toToon } from "./assets";

type Three = typeof ThreeNS;

/** The GLB file the cars live in. */
export const VEHICLES_ASSET = "office-cars.glb";

export type VehicleSet<Id extends string> = {
  /** A new group at the origin holding a clone of the vehicle (shares geometry and material with the others). */
  create: (id: Id) => ThreeNS.Group;
  dispose: () => void;
};

/** Next x of a car on a looping lane: moves east, re-enters from the west end once past the east end. */
export function advanceAlongLane(x: number, speed: number, dt: number, minX: number, maxX: number): number {
  const next = x + speed * dt;
  return next > maxX ? minX + (next - maxX) : next;
}

/**
 * Parses the GLB and turns the first mesh of each named node into a toon vehicle. `nodes` maps a vehicle id to the node
 * name inside the file; throws when one is missing (the caller keeps its stand-ins then).
 */
export async function loadVehicles<Id extends string>(THREE: Three, nodes: Record<Id, string>, asset: string = VEHICLES_ASSET): Promise<VehicleSet<Id>> {
  const model = await loadModel(asset);
  const owned: Array<{ dispose: () => void }> = [];
  const sources = new Map<Id, ThreeNS.Mesh>();
  for (const id of Object.keys(nodes) as Id[]) {
    const node = model.scene.getObjectByName(nodes[id]);
    let found: ThreeNS.Mesh | null = null;
    node?.traverse((o) => {
      if (!found && (o as ThreeNS.Mesh).isMesh) found = o as ThreeNS.Mesh;
    });
    if (!found) throw new Error(`pixel-world vehicles: ${nodes[id]} missing`);
    const mesh: ThreeNS.Mesh = found;
    toToon(THREE, mesh, owned);
    sources.set(id, mesh);
  }
  return {
    create(id) {
      const root = new THREE.Group();
      root.name = `car:${id}`;
      // keeps the node transform that undoes the position quantization
      root.add(sources.get(id)!.clone());
      return root;
    },
    dispose() {
      for (const item of owned) item.dispose();
    },
  };
}
