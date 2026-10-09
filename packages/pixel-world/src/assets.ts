import type * as ThreeNS from "three";
import { getPixelStyle } from "./pixel";

type Three = typeof ThreeNS;

/** Where the plugin serves the .glb files (src/rooms/world-assets/server); same origin as the BB app. */
export const DEFAULT_ASSET_BASE = "/api/v1/plugins/lane-pilot/http/world/assets/";

let assetBase = DEFAULT_ASSET_BASE;

/** Points the loader at another folder URL (a harness or a CDN). */
export function setAssetBase(base: string): void {
  assetBase = base.endsWith("/") ? base : `${base}/`;
}

export function assetUrl(name: string): string {
  return `${assetBase}${name}`;
}

const downloads = new Map<string, Promise<ArrayBuffer>>();

/** The bytes of one asset, downloaded once per page; a failed download is forgotten so the next call tries again. */
export function fetchAsset(name: string): Promise<ArrayBuffer> {
  let pending = downloads.get(name);
  if (!pending) {
    pending = fetch(assetUrl(name), { credentials: "same-origin" }).then((response) => {
      if (!response.ok) throw new Error(`asset ${name}: HTTP ${response.status}`);
      return response.arrayBuffer();
    });
    pending.catch(() => downloads.delete(name));
    downloads.set(name, pending);
  }
  return pending;
}

/** Forgets the downloaded bytes (tests, or after a deploy replaced a file). */
export function clearAssetCache(): void {
  downloads.clear();
}

export type LoadedModel = {
  scene: ThreeNS.Group;
  animations: ThreeNS.AnimationClip[];
  /** Clone of a node of `scene` with its own skeleton (SkeletonUtils.clone). */
  clone: (source: ThreeNS.Object3D) => ThreeNS.Object3D;
};

/**
 * Downloads (cached bytes) and parses one GLB. GLTFLoader makes node names unique (Hips_1, Spine_2 …) while the clips
 * address the plain names; the plain name survives in `userData.name`, and every bone gets it back.
 */
export async function loadModel(name: string): Promise<LoadedModel> {
  const [{ GLTFLoader }, SkeletonUtils, buffer] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/utils/SkeletonUtils.js"),
    fetchAsset(name),
  ]);
  const gltf = await new Promise<{ scene: ThreeNS.Group; animations: ThreeNS.AnimationClip[] }>((resolve, reject) => {
    new GLTFLoader().parse(buffer.slice(0), "", resolve, reject);
  });
  gltf.scene.traverse((o) => {
    if ((o as ThreeNS.Bone).isBone && typeof o.userData.name === "string") o.name = o.userData.name;
  });
  return { scene: gltf.scene, animations: gltf.animations, clone: (source) => SkeletonUtils.clone(source) };
}

/**
 * Replaces the standard material of a loaded mesh with a toon material on the shared gradient (texture kept, a little
 * glow so the 3 tones do not eat the texture). The old material goes; the new material, the geometry and the texture
 * are added to `owned` for the caller to dispose. Quantized positions pop out of the culling box, so culling is off.
 */
export function toToon(THREE: Three, mesh: ThreeNS.Mesh, owned: Array<{ dispose: () => void }>): void {
  const old = mesh.material as ThreeNS.MeshStandardMaterial;
  if (old.map) old.map.colorSpace = THREE.SRGBColorSpace;
  const toon = getPixelStyle(THREE).toon({ map: old.map ?? null, emissive: 0x333333, emissiveMap: old.map ?? null });
  old.dispose();
  mesh.material = toon;
  mesh.frustumCulled = false;
  owned.push(toon, mesh.geometry);
  if (toon.map) owned.push(toon.map);
}
