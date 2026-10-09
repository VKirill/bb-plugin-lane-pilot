import type * as ThreeType from "three";
import { MESH_EDGE_LINES, getPixelStyle } from "./pixel";

/** World-space floor rectangle. */
export type FloorRect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Outline colour #282a36. */
export const OUTLINE_COLOR = 0x282a36;

const mid = (a: number, b: number) => (a + b) / 2;

/**
 * Drawing helpers the floor builder hands to the prop modules, so every prop shares the scene's
 * pixel-art style: 3-tone toon materials cached by colour; outlines come from the depth post pass.
 */
export type PropsKit = {
  THREE: typeof import("three");
  scene: ThreeType.Scene;
  disposables: Array<{ dispose: () => void }>;
  /** Box from world bounds (`outline` only matters with MESH_EDGE_LINES). Returns the mesh (position may be changed). */
  box: (
    parent: ThreeType.Object3D,
    minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number,
    color: number,
    opts?: { outline?: boolean; opacity?: number }
  ) => ThreeType.Mesh;
  /** Box over a grid rectangle (gx0–gx1 × gz0–gz1) and a height range. */
  gridBox: (
    parent: ThreeType.Object3D,
    gx0: number, gx1: number, gz0: number, gz1: number, minY: number, maxY: number,
    color: number,
    opts?: { outline?: boolean; opacity?: number }
  ) => ThreeType.Mesh;
  /** Faceted ball with a silhouette outline (canopies, cushions, fruit, heads of decor). */
  blob: (parent: ThreeType.Object3D, x: number, y: number, z: number, radius: number, color: number, squashY?: number) => ThreeType.Mesh;
  /** Unoutlined 8-sided cylinder. */
  cylinder: (parent: ThreeType.Object3D, x: number, z: number, radius: number, minY: number, maxY: number, color: number) => ThreeType.Mesh;
  /** Cached toon material. */
  material: (color: number, opacity?: number) => ThreeType.MeshToonMaterial;
  /** Outline colour #282a36. */
  OUTLINE: number;
  /** Name given to meshes built next (the geometry audit reports overlaps by part). */
  setPart: (name: string) => void;
};

export type PropsKitOptions = {
  THREE: typeof import("three");
  scene: ThreeType.Scene;
  /** Everything the kit creates that needs `dispose()` is pushed here. */
  disposables: Array<{ dispose: () => void }>;
  /** World position of grid point (0, 0): the grid is `x = origin.x + gx`, `z = origin.z + gz`. Default (0, 0). */
  gridOrigin?: { x: number; z: number };
};

/** The drawing helpers over one scene: boxes, balls and cylinders on cached 3-tone toon materials. */
export function createPropsKit({ THREE, scene, disposables, gridOrigin = { x: 0, z: 0 } }: PropsKitOptions): PropsKit {
  const pixelStyle = getPixelStyle(THREE);
  const outlineMat = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR });
  disposables.push(outlineMat);

  let part = "floor";
  const materials = new Map<string, ThreeType.MeshToonMaterial>();
  const material = (color: number, opacity?: number) => {
    const key = `${color}:${opacity ?? 1}`;
    let mat = materials.get(key);
    if (!mat) {
      mat = pixelStyle.toon({ color, transparent: opacity !== undefined, opacity: opacity ?? 1 });
      materials.set(key, mat);
      disposables.push(mat);
    }
    return mat;
  };

  const box: PropsKit["box"] = (parent, minX, maxX, minY, maxY, minZ, maxZ, color, opts) => {
    const geom = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
    disposables.push(geom);
    const mesh = new THREE.Mesh(geom, material(color, opts?.opacity));
    mesh.name = part;
    mesh.position.set(mid(minX, maxX), mid(minY, maxY), mid(minZ, maxZ));
    if (MESH_EDGE_LINES && opts?.outline !== false) {
      const edges = new THREE.EdgesGeometry(geom, 30);
      disposables.push(edges);
      mesh.add(new THREE.LineSegments(edges, outlineMat));
    }
    parent.add(mesh);
    return mesh;
  };

  const gridBox: PropsKit["gridBox"] = (parent, gx0, gx1, gz0, gz1, minY, maxY, color, opts) =>
    box(parent, gridOrigin.x + gx0, gridOrigin.x + gx1, minY, maxY, gridOrigin.z + gz0, gridOrigin.z + gz1, color, opts);

  const cylinder: PropsKit["cylinder"] = (parent, x, z, radius, minY, maxY, color) => {
    const geom = new THREE.CylinderGeometry(radius, radius, maxY - minY, 8);
    disposables.push(geom);
    const mesh = new THREE.Mesh(geom, material(color));
    mesh.position.set(x, mid(minY, maxY), z);
    parent.add(mesh);
    return mesh;
  };

  // Pixel art outlines only the silhouette, so the (disabled) outline of a ball is an inverted hull, not every facet edge
  const hullMat = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  disposables.push(hullMat);
  const blob: PropsKit["blob"] = (parent, x, y, z, radius, color, squashY = 1) => {
    const geom = new THREE.IcosahedronGeometry(radius, 1);
    geom.computeVertexNormals(); // non-indexed: one normal per facet (toon materials have no flatShading)
    disposables.push(geom);
    const mesh = new THREE.Mesh(geom, material(color));
    mesh.name = part;
    mesh.position.set(x, y, z);
    mesh.scale.y = squashY;
    if (MESH_EDGE_LINES) {
      const hull = new THREE.Mesh(geom, hullMat);
      hull.scale.setScalar(1 + 0.07 / radius);
      mesh.add(hull);
    }
    parent.add(mesh);
    return mesh;
  };

  return {
    THREE,
    scene,
    disposables,
    box,
    gridBox,
    blob,
    cylinder,
    material,
    OUTLINE: OUTLINE_COLOR,
    setPart: (name) => {
      part = name;
    },
  };
}
