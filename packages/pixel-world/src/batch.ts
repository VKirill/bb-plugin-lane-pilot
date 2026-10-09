import type * as ThreeNS from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getPixelStyle } from "./pixel";

type Three = typeof ThreeNS;

/** `THREE.FrontSide`. */
const THREE_FRONT_SIDE = 0;

export type BatchOptions = {
  /**
   * A group whose meshes are merged among themselves, in the group's own space, and stay under it (so it can still
   * move or hide as a whole: the box cars of the office). Everything else merges into the root.
   */
  isolate?: (object: ThreeNS.Object3D) => boolean;
};

export type BatchResult = {
  /** The merged meshes that replaced the static ones (opaque and transparent, per root or isolated group). */
  meshes: ThreeNS.Mesh[];
  /** How many meshes and triangles went in. */
  sourceMeshes: number;
  sourceTriangles: number;
  dispose: () => void;
};

/** A plain toon mesh the batcher may bake: one toon material, no texture, no glow, front faces only, nothing animated. */
function isBatchable(o: ThreeNS.Object3D): o is ThreeNS.Mesh {
  const mesh = o as ThreeNS.Mesh;
  if (!mesh.isMesh || (o as ThreeNS.SkinnedMesh).isSkinnedMesh || (o as ThreeNS.InstancedMesh).isInstancedMesh || !mesh.visible) return false;
  const mat = mesh.material as ThreeNS.MeshToonMaterial | ThreeNS.Material[];
  if (Array.isArray(mat) || (mat as ThreeNS.MeshToonMaterial).type !== "MeshToonMaterial") return false;
  const toon = mat as ThreeNS.MeshToonMaterial;
  return !toon.map && !toon.emissiveMap && toon.emissive.getHex() === 0 && toon.side === THREE_FRONT_SIDE && !toon.vertexColors && mesh.children.length === 0 && !mesh.userData.noBatch;
}

/**
 * Merges the static toon meshes under `root` into a few big geometries. The colour of every source material is baked
 * into vertex colours (alpha too for the see-through ones), so all opaque meshes share one material and all
 * transparent ones another: a scene of two thousand boxes becomes two draw calls. World matrices are baked in, so
 * the wall cut (which reads world positions) works unchanged. Meshes under an object with `userData.noBatch`,
 * invisible ones, skinned and textured meshes stay as they are; do this once after the scene is built and before the
 * dynamic things (people, cars) are added.
 */
export function batchStatic(THREE: Three, root: ThreeNS.Object3D, options: BatchOptions = {}): BatchResult {
  root.updateMatrixWorld(true);
  const style = getPixelStyle(THREE);
  const result: BatchResult = { meshes: [], sourceMeshes: 0, sourceTriangles: 0, dispose: () => {} };
  const owned: Array<{ dispose: () => void }> = [];
  const opaqueMaterial = style.toon({ vertexColors: true });
  const glassMaterial = style.toon({ vertexColors: true, transparent: true });
  owned.push(opaqueMaterial, glassMaterial);

  // Which merge target (the root, or an isolated group) each static mesh belongs to
  const targets = new Map<ThreeNS.Object3D, ThreeNS.Mesh[]>([[root, []]]);
  const visit = (o: ThreeNS.Object3D, target: ThreeNS.Object3D) => {
    if (!o.visible || o.userData.noBatch) return;
    if (o !== root && options.isolate?.(o)) {
      target = o;
      targets.set(o, []);
    }
    if (isBatchable(o)) targets.get(target)!.push(o);
    for (const child of o.children) visit(child, target);
  };
  visit(root, root);

  const toTarget = new THREE.Matrix4();
  const color = new THREE.Color();
  for (const [target, meshes] of targets) {
    toTarget.copy(target.matrixWorld).invert();
    const groups = { opaque: [] as ThreeNS.BufferGeometry[], glass: [] as ThreeNS.BufferGeometry[] };
    for (const mesh of meshes) {
      const toon = mesh.material as ThreeNS.MeshToonMaterial;
      const glass = toon.transparent;
      const source = mesh.geometry;
      const matrix = new THREE.Matrix4().multiplyMatrices(toTarget, mesh.matrixWorld);

      // Only what the toon shader reads: position, normal, an index and the baked colour
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", source.getAttribute("position").clone());
      if (source.getAttribute("normal")) geometry.setAttribute("normal", source.getAttribute("normal").clone());
      if (source.index) geometry.setIndex(source.index.clone());
      else geometry.setIndex(Array.from({ length: source.getAttribute("position").count }, (_, i) => i));
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      geometry.applyMatrix4(matrix);
      if (matrix.determinant() < 0) {
        // A mirrored mesh turns inside out; flip the winding back
        const index = geometry.index!;
        for (let i = 0; i < index.count; i += 3) {
          const b = index.getX(i + 1);
          index.setX(i + 1, index.getX(i + 2));
          index.setX(i + 2, b);
        }
      }
      const count = geometry.getAttribute("position").count;
      const size = glass ? 4 : 3;
      const colors = new Float32Array(count * size);
      color.copy(toon.color);
      for (let i = 0; i < count; i++) {
        colors[i * size] = color.r;
        colors[i * size + 1] = color.g;
        colors[i * size + 2] = color.b;
        if (glass) colors[i * size + 3] = toon.opacity;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, size));
      (glass ? groups.glass : groups.opaque).push(geometry);

      result.sourceMeshes += 1;
      result.sourceTriangles += (source.index ? source.index.count : source.getAttribute("position").count) / 3;
      let parent = mesh.parent;
      mesh.removeFromParent();
      // An emptied group is not worth a matrix update every frame
      while (parent && parent !== root && parent !== target && parent.children.length === 0) {
        const up: ThreeNS.Object3D | null = parent.parent;
        parent.removeFromParent();
        parent = up;
      }
    }
    for (const [list, material, name] of [[groups.opaque, opaqueMaterial, "batch:opaque"], [groups.glass, glassMaterial, "batch:glass"]] as const) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      owned.push(merged);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = name;
      mesh.matrixAutoUpdate = false;
      target.add(mesh);
      mesh.updateMatrixWorld(true);
      result.meshes.push(mesh);
    }
  }

  result.dispose = () => {
    for (const item of owned) item.dispose();
  };
  return result;
}
