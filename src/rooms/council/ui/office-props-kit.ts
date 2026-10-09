import type * as ThreeType from "three";

/** World-space floor rectangle (x = gx − 20, z = gz − 10). */
export type FloorRect = { minX: number; maxX: number; minZ: number; maxZ: number };

/**
 * Drawing helpers the floor builder hands to the prop modules, so every prop shares the scene's
 * pixel-art style: Lambert materials cached by colour, dark outlines on boxes, silhouette-outlined balls.
 */
export type PropsKit = {
  THREE: typeof import("three");
  scene: ThreeType.Scene;
  disposables: Array<{ dispose: () => void }>;
  /** Box from world bounds; outlined unless `outline: false`. Returns the mesh (position may be changed). */
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
  /** Cached Lambert material. */
  material: (color: number, opacity?: number) => ThreeType.MeshLambertMaterial;
  /** Outline colour #282a36. */
  OUTLINE: number;
  /** Name given to meshes built next (the geometry audit reports overlaps by part). */
  setPart: (name: string) => void;
};
