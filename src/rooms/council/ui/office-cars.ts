/**
 * Stylised cars for the lot outside the council office (assets/office-cars.glb, embedded as base64 because the
 * plugin bundles into one app.js). Seven single-mesh models on the scene's toon gradient. The box cars drawn by
 * office-props-b.ts stay as the fallback: they are hidden once the cars are added, and stay if the GLB cannot load.
 *
 * Model space: metres, ground at y = 0, centred on x/z, the front faces +Z (see assets/office-cars.md).
 */
import type * as ThreeNS from "three";
import { getPixelStyle } from "./office-pixel";

type Three = typeof ThreeNS;

export type CarId = "mustang" | "raptor" | "porsche911" | "gwagon" | "supercar" | "cybertruck" | "vwbus";

export const CAR_IDS: readonly CarId[] = ["mustang", "raptor", "porsche911", "gwagon", "supercar", "cybertruck", "vwbus"];

/** Node name of each car inside the GLB. */
export const CAR_NODE: Record<CarId, string> = {
  mustang: "car_mustang",
  raptor: "car_raptor",
  porsche911: "car_911",
  gwagon: "car_gwagon",
  supercar: "car_supercar",
  cybertruck: "car_cybertruck",
  vwbus: "car_vwbus",
};

/** Ground of the lot (world y of the paving the cars stand on). */
export const CAR_GROUND_Y = -0.49;

/** `userData` flag that office-props-b.ts puts on the groups of its box cars. */
export const BOX_CAR_FLAG = "boxCar";

export type CarSpot = { car: CarId; x: number; z: number; heading: number };

/**
 * Where the cars stand: the south parking bays (tail to the kerb, nose to the street) and the east strip
 * (nose to the east).
 */
export const CAR_SPOTS: readonly CarSpot[] = [
  { car: "supercar", x: -15.4, z: 16.9, heading: 0 },
  { car: "mustang", x: -9.8, z: 16.9, heading: 0 },
  { car: "porsche911", x: -4.2, z: 16.9, heading: 0 },
  { car: "vwbus", x: 1.4, z: 16.9, heading: 0 },
  { car: "raptor", x: 7.0, z: 17.4, heading: 0 },
  { car: "gwagon", x: 25.0, z: -1.3, heading: Math.PI / 2 },
  { car: "cybertruck", x: 25.0, z: 2.1, heading: Math.PI / 2 },
];

export type CarDriver = { car: CarId; z: number; speed: number; startX: number };

/** Cars looping along the east-bound lane of the street (world units, units per second). */
export const DRIVE_MIN_X = -46;
export const DRIVE_MAX_X = 28;
export const CAR_DRIVERS: readonly CarDriver[] = [
  { car: "porsche911", z: 23.3, speed: 3.2, startX: -30 },
  { car: "vwbus", z: 23.3, speed: 3.2, startX: 7 },
];

/** Next x of a driving car: moves east, re-enters from the west edge once past the east edge. */
export function advanceDriver(x: number, speed: number, dt: number): number {
  const next = x + speed * dt;
  return next > DRIVE_MAX_X ? DRIVE_MIN_X + (next - DRIVE_MAX_X) : next;
}

export type OfficeCars = {
  /** Meshes added to the scene, one per spot. */
  cars: ThreeNS.Object3D[];
  /** Moves the driving cars. */
  update: (dt: number) => void;
  dispose: () => void;
};

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Parses the embedded GLB, puts the cars on their spots and hides the box cars. Resolves after the first
 * frames have no need to wait for it; rejects (the box cars stay) when the GLB cannot be parsed.
 */
export async function loadOfficeCars(THREE: Three, scene: ThreeNS.Scene): Promise<OfficeCars> {
  const [{ GLTFLoader }, { OFFICE_CARS_GLB_BASE64 }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("./assets/office-cars-glb"),
  ]);
  const gltf = await new Promise<{ scene: ThreeNS.Group }>((resolve, reject) => {
    new GLTFLoader().parse(decodeBase64(OFFICE_CARS_GLB_BASE64), "", resolve, reject);
  });

  const style = getPixelStyle(THREE);
  const owned: Array<{ dispose: () => void }> = [];
  const sources = new Map<CarId, ThreeNS.Mesh>();
  for (const id of CAR_IDS) {
    const node = gltf.scene.getObjectByName(CAR_NODE[id]);
    let found: ThreeNS.Mesh | null = null;
    node?.traverse((o) => {
      if (!found && (o as ThreeNS.Mesh).isMesh) found = o as ThreeNS.Mesh;
    });
    if (!found) throw new Error(`office-cars: ${CAR_NODE[id]} missing`);
    const mesh: ThreeNS.Mesh = found;
    const old = mesh.material as ThreeNS.MeshStandardMaterial;
    if (old.map) old.map.colorSpace = THREE.SRGBColorSpace;
    const toon = style.toon({ map: old.map ?? null, emissive: 0x333333, emissiveMap: old.map ?? null });
    old.dispose();
    mesh.material = toon;
    mesh.frustumCulled = false; // quantized positions pop out of the culling box
    owned.push(toon, mesh.geometry);
    if (toon.map) owned.push(toon.map);
    sources.set(id, mesh);
  }

  const cars: ThreeNS.Object3D[] = [];
  const addCar = (car: CarId, x: number, z: number, heading: number) => {
    const root = new THREE.Group();
    root.name = `car:${car}`;
    root.position.set(x, CAR_GROUND_Y, z);
    root.rotation.y = heading;
    // shares the geometry and the material; keeps the node transform that undoes the position quantization
    root.add(sources.get(car)!.clone());
    scene.add(root);
    cars.push(root);
    return root;
  };
  for (const spot of CAR_SPOTS) addCar(spot.car, spot.x, spot.z, spot.heading);
  const driving = CAR_DRIVERS.map((d) => ({ root: addCar(d.car, d.startX, d.z, Math.PI / 2), speed: d.speed }));
  scene.traverse((o) => {
    if (o.userData[BOX_CAR_FLAG]) o.visible = false;
  });

  return {
    cars,
    update(dt) {
      for (const d of driving) d.root.position.x = advanceDriver(d.root.position.x, d.speed, dt);
    },
    dispose() {
      for (const root of cars) root.removeFromParent();
      for (const item of owned) item.dispose();
    },
  };
}
