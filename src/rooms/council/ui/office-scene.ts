import type * as ThreeType from "three";
import { OFFICE_PROPS, OFFICE_WALLS, gridRect, type PropFootprint } from "./office-layout";

export type OfficeSceneOptions = {
  THREE: typeof import("three");
  scene: import("three").Scene;
  disposables: Array<{ dispose: () => void }>;
};

// Palette (reference.md §3)
const OUTLINE = 0x282a36;
const SKY = 0xacddec;
const GRASS = 0x93c06b;
const PAVING = 0xc1bcc0;
const SLAB = 0x413c42;
const WALL_CREAM = 0xf7edd2;
const WALL_CREAM_SHADE = 0xe6cfaf;
const WALNUT = 0x7b4a2e;
const WALNUT_TOP = 0x8f5a38;
const LEATHER = 0x7a3b22;
const LEATHER_DARK = 0x6e3420;
const BRASS = 0xd4a537;
const TEAL = 0x3e898e;
const TERRACOTTA = 0xce6b4e;
const LEAF = 0x669e3b;
const LEAF_SHADE = 0x518530;
const CHAIR_BASE = 0x3a3d4a;
const CHAIR_SEAT = 0x5b6070;
const CUSHION_ORANGE = 0xcb614b;
const CUSHION_SLATE = 0x64748b;
const CUSHION_ROSE = 0xe11d48;
const GLASS = 0xcdf1ff;

const FLOOR_ZONES: Array<{ color: number; gx0: number; gx1: number; gz0: number; gz1: number }> = [
  { color: 0xeab06e, gx0: 0, gx1: 12, gz0: 0, gz1: 11 },
  { color: 0xdfb988, gx0: 12, gx1: 26, gz0: 0, gz1: 11 },
  { color: 0xb9774a, gx0: 26, gx1: 40, gz0: 0, gz1: 11 },
  { color: 0xbfccd4, gx0: 0, gx1: 40, gz0: 11, gz1: 13 },
  { color: 0xe69d59, gx0: 0, gx1: 11, gz0: 13, gz1: 20 },
  { color: 0xf0c8a2, gx0: 11, gx1: 21, gz0: 13, gz1: 20 },
  { color: 0xc9d3d8, gx0: 21, gx1: 28, gz0: 13, gz1: 20 },
  { color: 0xe69d59, gx0: 28, gx1: 40, gz0: 13, gz1: 20 },
];

const TREES: Array<[number, number]> = [
  [-24, -4],
  [-23, 6],
  [-12, 13],
  [10, 14],
  [24, -4],
  [28, 12],
];

const mid = (a: number, b: number) => (a + b) / 2;

/**
 * Builds the bright isometric cutaway office floor from the layout: slab, zones, walls and doors,
 * the furniture from `OFFICE_PROPS`, and the exterior lot. Every solid has dark pixel outlines.
 */
export function buildOfficeFloor({ THREE, scene, disposables }: OfficeSceneOptions): void {
  const outlineMat = new THREE.LineBasicMaterial({ color: OUTLINE });
  disposables.push(outlineMat);

  const materials = new Map<string, ThreeType.MeshLambertMaterial>();
  const material = (color: number, opacity?: number) => {
    const key = `${color}:${opacity ?? 1}`;
    let mat = materials.get(key);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color, transparent: opacity !== undefined, opacity: opacity ?? 1 });
      materials.set(key, mat);
      disposables.push(mat);
    }
    return mat;
  };

  /** Box from world bounds, outlined unless `outline` is false. */
  const box = (
    parent: ThreeType.Object3D,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    color: number,
    opts?: { outline?: boolean; opacity?: number }
  ): ThreeType.Mesh => {
    const geom = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
    disposables.push(geom);
    const mesh = new THREE.Mesh(geom, material(color, opts?.opacity));
    mesh.position.set(mid(minX, maxX), mid(minY, maxY), mid(minZ, maxZ));
    if (opts?.outline !== false) {
      const edges = new THREE.EdgesGeometry(geom, 30);
      disposables.push(edges);
      mesh.add(new THREE.LineSegments(edges, outlineMat));
    }
    parent.add(mesh);
    return mesh;
  };

  /** Box over a grid rectangle (gx0–gx1 × gz0–gz1) and a height range. */
  const gridBox = (
    parent: ThreeType.Object3D,
    gx0: number,
    gx1: number,
    gz0: number,
    gz1: number,
    minY: number,
    maxY: number,
    color: number,
    opts?: { outline?: boolean; opacity?: number }
  ) => {
    const r = gridRect(gx0, gx1, gz0, gz1);
    return box(parent, r.minX, r.maxX, minY, maxY, r.minZ, r.maxZ, color, opts);
  };

  const cylinder = (parent: ThreeType.Object3D, x: number, z: number, radius: number, minY: number, maxY: number, color: number) => {
    const geom = new THREE.CylinderGeometry(radius, radius, maxY - minY, 8);
    disposables.push(geom);
    const mesh = new THREE.Mesh(geom, material(color));
    mesh.position.set(x, mid(minY, maxY), z);
    parent.add(mesh);
    return mesh;
  };

  /** Low-poly ball (icosahedron) with outlines: tree canopies, bushes, leaf clusters. */
  const blob = (parent: ThreeType.Object3D, x: number, y: number, z: number, radius: number, color: number, squashY = 1) => {
    const geom = new THREE.IcosahedronGeometry(radius, 0);
    disposables.push(geom);
    const mat = material(color);
    mat.flatShading = true;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(x, y, z);
    mesh.scale.y = squashY;
    const edges = new THREE.EdgesGeometry(geom, 30);
    disposables.push(edges);
    mesh.add(new THREE.LineSegments(edges, outlineMat));
    parent.add(mesh);
    return mesh;
  };

  /** Leafy pot plant: a pot, soil and a fan of leaves around a central cluster. */
  const pottedPlant = (cx: number, cz: number, potHalf: number, height: number, pot: number) => {
    box(scene, cx - potHalf, cx + potHalf, 0, 0.45, cz - potHalf, cz + potHalf, pot);
    box(scene, cx - potHalf + 0.04, cx + potHalf - 0.04, 0.45, 0.47, cz - potHalf + 0.04, cz + potHalf - 0.04, 0x5a3d2b, { outline: false });
    const leafCount = 7;
    for (let i = 0; i < leafCount; i++) {
      const leaf = new THREE.Group();
      leaf.position.set(cx, 0.47, cz);
      leaf.rotation.y = (i / leafCount) * Math.PI * 2 + cx * 0.7;
      const blade = new THREE.Group();
      blade.rotation.z = 0.55 + (i % 3) * 0.18;
      leaf.add(blade);
      const len = (height - 0.4) * (0.75 + (i % 2) * 0.25);
      box(blade, -0.05, 0.05, 0, len, -0.13, 0.13, i % 2 === 0 ? LEAF : LEAF_SHADE);
      scene.add(leaf);
    }
    blob(scene, cx, 0.45 + (height - 0.45) * 0.62, cz, Math.max(0.22, potHalf * 0.9), LEAF, 1.25);
  };

  // ==========================================
  // 1. SLAB, GROUND, PAVING AND TREES
  // ==========================================
  scene.background = new THREE.Color(SKY);
  // The slab top stays just below the floor zones, so the two never share a plane (no z-fighting)
  box(scene, -20, 20, -0.5, -0.05, -10, 10, SLAB, { outline: false });

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), material(GRASS));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  disposables.push(ground.geometry);
  scene.add(ground);

  // Paving from the entrance door and along the south edge, running out of frame
  box(scene, 21, 70, -0.52, -0.49, 5.5, 8.5, PAVING, { outline: false });
  box(scene, -30, 70, -0.52, -0.49, 11, 13, PAVING, { outline: false });

  for (const [x, z] of TREES) {
    box(scene, x - 0.15, x + 0.15, -0.5, 0.7, z - 0.15, z + 0.15, 0x8a5a3c);
    blob(scene, x, 1.45, z, 1.0, 0x81b352);
    blob(scene, x + 0.25, 2.05, z + 0.2, 0.6, 0x93c45f);
  }

  // Flower bushes along the slab edges (front and east), as in the reference picture
  const flowerColors = [0xf6f0f6, 0xc58be0, 0xf48fb1];
  const bushes: Array<[number, number]> = [[-17, 10.9], [-9, 10.8], [-2, 10.9], [6, 10.8], [14, 10.9], [20.9, -6], [20.9, 1], [20.9, 9.5]];
  bushes.forEach(([x, z], i) => {
    blob(scene, x, -0.2, z, 0.45, 0x669e3b, 0.8);
    for (let k = 0; k < 3; k++) {
      const a = k * 2.1 + i;
      const fx = x + Math.cos(a) * 0.28;
      const fz = z + Math.sin(a) * 0.28;
      box(scene, fx - 0.06, fx + 0.06, 0.05, 0.15, fz - 0.06, fz + 0.06, flowerColors[(i + k) % 3]!, { outline: false });
    }
  });

  // Street lamp at grid (43, 21)
  box(scene, 22.9, 23.1, -0.5, 1.8, 10.9, 11.1, 0x3a3d4a);
  box(scene, 22.7, 23.3, 1.8, 2.0, 10.7, 11.3, 0xf9e79f);

  // ==========================================
  // 2. FLOOR ZONES
  // ==========================================
  for (const zone of FLOOR_ZONES) {
    gridBox(scene, zone.gx0, zone.gx1, zone.gz0, zone.gz1, -0.05, 0, zone.color, { outline: false });
  }

  // ==========================================
  // 3. WALLS, WINDOWS AND DOORS
  // ==========================================
  const WALL_H = 3.5;
  // Back walls: north (gz 0) and west (gx 0), full height
  box(scene, -20, 20, 0, WALL_H, -10.3, -10, WALL_CREAM);
  box(scene, -20.3, -20, 0, WALL_H, -10, 10, WALL_CREAM);
  // Front stubs (cutaway) on the south edge and the east edge, with the entrance door gap at gz 16–18
  box(scene, -20, 20, 0, 0.35, 10, 10.3, WALL_CREAM_SHADE);
  box(scene, 20, 20.3, 0, 0.35, -10, 6, WALL_CREAM_SHADE);
  box(scene, 20, 20.3, 0, 0.35, 8, 10, WALL_CREAM_SHADE);

  // Windows on the north wall (gx 13–16, 17–20, 21–24) and the west wall (meeting gz 3–7, lounge gz 15–18).
  // The wall is solid, so the view outside (sky, tree tops) is painted on it under the glass.
  const northWindow = (x0: number, x1: number, y0: number, y1: number, panes: number) => {
    box(scene, x0, x1, y0, y1, -10.0, -9.99, 0xcdeefa, { outline: false });
    for (let i = 0; i < 3; i++) {
      const tx = x0 + ((i + 0.5) * (x1 - x0)) / 3;
      box(scene, tx - 0.45, tx + 0.45, y0, y0 + 0.55 + (i % 2) * 0.25, -9.99, -9.98, i % 2 ? 0x9fcf7a : 0x8cc06a, { outline: false });
    }
    box(scene, x0, x1, y0, y1, -9.98, -9.95, GLASS, { outline: false, opacity: 0.35 });
    for (let i = 0; i <= panes; i++) {
      const x = x0 + (i * (x1 - x0)) / panes;
      box(scene, x - 0.05, x + 0.05, y0, y1, -9.98, -9.92, 0xffffff);
    }
    box(scene, x0 - 0.05, x1 + 0.05, y0 - 0.08, y0, -9.98, -9.88, 0xffffff);
    box(scene, x0 - 0.05, x1 + 0.05, y1, y1 + 0.06, -9.98, -9.92, 0xffffff);
    // Diagonal glare streak
    const streak = box(scene, -0.06, 0.06, -0.5, 0.5, 0, 0.005, 0xffffff, { outline: false, opacity: 0.6 });
    streak.position.set(x0 + (x1 - x0) * 0.3, (y0 + y1) / 2, -9.94);
    streak.rotation.z = -0.6;
  };
  for (const [gx0, gx1] of [[13, 16], [17, 20], [21, 24]] as const) northWindow(gx0 - 20, gx1 - 20, 0.9, 2.9, 2);

  const westWindow = (z0: number, z1: number) => {
    box(scene, -20.0, -19.99, 0.9, 2.9, z0, z1, 0xcdeefa, { outline: false });
    box(scene, -19.99, -19.98, 0.9, 1.5, z0 + 0.3, z1 - 0.3, 0x9fcf7a, { outline: false });
    box(scene, -19.98, -19.95, 0.9, 2.9, z0, z1, GLASS, { outline: false, opacity: 0.35 });
    for (const z of [z0, (z0 + z1) / 2, z1]) box(scene, -19.98, -19.92, 0.9, 2.9, z - 0.05, z + 0.05, 0xffffff);
    box(scene, -19.98, -19.88, 0.82, 0.9, z0 - 0.05, z1 + 0.05, 0xffffff);
  };
  westWindow(-7, -3);
  westWindow(5, 8);

  // Panoramic window in the director's office (gx 30.4–39.6): city skyline and tree tops behind six panes
  box(scene, 10.4, 19.6, 0.6, 3.2, -10.0, -9.99, 0xcdeefa, { outline: false });
  const skyline: Array<[number, number, number]> = [
    [10.5, 11.6, 2.6], [11.7, 12.4, 3.1], [12.5, 13.6, 2.2], [13.7, 14.5, 2.9], [14.6, 15.9, 2.4],
    [16.0, 16.7, 3.15], [16.8, 17.9, 2.5], [18.0, 18.8, 2.8], [18.9, 19.5, 2.3],
  ];
  skyline.forEach(([x0, x1, top], i) => {
    box(scene, x0, x1, 0.6, top, -9.99, -9.985, i % 2 ? 0x9fb3c8 : 0xb8c8d8, { outline: false });
    for (let y = 1.4; y < top - 0.2; y += 0.35) {
      box(scene, x0 + 0.12, x1 - 0.12, y, y + 0.12, -9.985, -9.982, 0xdfe8f0, { outline: false });
    }
  });
  for (let i = 0; i < 6; i++) {
    const tx = 11 + i * 1.6;
    box(scene, tx - 0.6, tx + 0.6, 0.6, 1.3 + (i % 2) * 0.25, -9.982, -9.978, i % 2 ? 0x9fcf7a : 0x86bb63, { outline: false });
  }
  box(scene, 10.4, 19.6, 0.6, 3.2, -9.975, -9.95, GLASS, { outline: false, opacity: 0.3 });
  for (let i = 0; i <= 6; i++) {
    const x = 10.4 + i * (9.2 / 6);
    box(scene, x - 0.05, x + 0.05, 0.6, 3.2, -9.97, -9.9, 0xffffff);
  }
  box(scene, 10.35, 19.65, 0.52, 0.6, -9.97, -9.86, 0xffffff);
  box(scene, 10.35, 19.65, 3.2, 3.26, -9.97, -9.9, 0xffffff);

  // Wall screen (north wall gx 4–8, y 1.3–2.6) and the whiteboard (west wall gz 7.5–10, y 1.0–2.3)
  box(scene, -16, -12, 1.3, 2.6, -10.1, -9.95, 0x2f3340);
  box(scene, -15.8, -12.2, 1.45, 2.45, -9.94, -9.9, 0x2b4a6b, { outline: false });
  [0.35, 0.55, 0.45, 0.75, 0.65, 0.9].forEach((hgt, i) => {
    const x = -15.5 + i * 0.5;
    box(scene, x, x + 0.3, 1.55, 1.55 + hgt * 0.75, -9.9, -9.89, i % 2 ? 0x38bdf8 : 0x4ade80, { outline: false });
  });
  box(scene, -20.1, -19.95, 1.0, 2.3, -2.5, 0, 0xffffff, { outline: false });
  box(scene, -20.0, -19.9, 1.8, 2.0, -2.3, -2.1, 0xf472b6);
  box(scene, -20.0, -19.9, 1.8, 2.0, -1.6, -1.4, 0xfef08a);
  box(scene, -20.0, -19.9, 1.8, 2.0, -0.9, -0.7, 0x67e8f9);

  // Interior walls from the layout: glass in the meeting room, walnut in the director's office, server grey in the server room
  for (const wall of OFFICE_WALLS) {
    if (wall.id.startsWith("wall_meeting")) {
      box(scene, wall.minX, wall.maxX, 0, 2.6, wall.minZ, wall.maxZ, 0xcfe6ee, { outline: false, opacity: 0.35 });
      box(scene, wall.minX, wall.maxX, 2.5, 2.6, wall.minZ, wall.maxZ, 0xf4f7f8);
      box(scene, wall.minX, wall.maxX, 0, 0.08, wall.minZ, wall.maxZ, 0xf4f7f8);
      const alongX = wall.maxX - wall.minX > wall.maxZ - wall.minZ;
      const [from, to] = alongX ? [wall.minX, wall.maxX] : [wall.minZ, wall.maxZ];
      for (let at = from; at <= to + 0.01; at += Math.min(2, to - from)) {
        if (alongX) box(scene, at - 0.06, at + 0.06, 0, 2.5, wall.minZ - 0.02, wall.maxZ + 0.02, 0xf4f7f8);
        else box(scene, wall.minX - 0.02, wall.maxX + 0.02, 0, 2.5, at - 0.06, at + 0.06, 0xf4f7f8);
      }
      continue;
    }
    const isWalnut = wall.id.startsWith("wall_director");
    const isServer = wall.id.startsWith("wall_server") || wall.id === "wall_kitchen_server";
    const color = isWalnut ? WALNUT : isServer ? 0xe8eef0 : WALL_CREAM;
    box(scene, wall.minX, wall.maxX, 0, wall.height, wall.minZ, wall.maxZ, color);
    box(scene, wall.minX - 0.02, wall.maxX + 0.02, wall.height, wall.height + 0.04, wall.minZ - 0.02, wall.maxZ + 0.02, OUTLINE);
    if (isWalnut) {
      box(scene, wall.minX - 0.01, wall.maxX + 0.01, 1.3, 1.34, wall.minZ - 0.01, wall.maxZ + 0.01, BRASS, { outline: false });
    }
  }

  // Director's double door (gx 33.8–35.8, walnut leaves with brass handles, cornice over the opening)
  box(scene, 13.8, 15.8, 0, 2.4, 0.85, 1.15, LEATHER_DARK);
  box(scene, 13.8, 15.8, 2.4, 2.7, 0.85, 1.15, WALNUT);
  box(scene, 14.1, 14.3, 0.8, 1.2, 0.7, 0.8, BRASS, { outline: false });
  box(scene, 15.3, 15.5, 0.8, 1.2, 0.7, 0.8, BRASS, { outline: false });
  // Glass double door on the east edge (gz 16–18)
  box(scene, 19.9, 20.1, 0, 2.4, -4, -2, 0xaee1f4, { outline: false, opacity: 0.55 });
  box(scene, 19.9, 20.1, 0, 2.4, 6.2, 6.3, 0xaee1f4, { outline: false, opacity: 0.55 });
  box(scene, 19.9, 20.1, 0, 2.4, 7.9, 8.0, 0xaee1f4, { outline: false, opacity: 0.55 });
  box(scene, 20, 21.2, -0.02, 0.01, 6, 8, 0x8a6a4a, { outline: false });

  // ==========================================
  // 4. FURNITURE FROM THE LAYOUT
  // ==========================================
  const buildChair = (
    x: number,
    z: number,
    angle: number,
    cushion: number,
    options?: { leather?: boolean; highBack?: boolean }
  ) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = angle;
    const seatColor = options?.leather ? LEATHER : cushion;
    box(group, -0.25, 0.25, 0.42, 0.52, -0.25, 0.25, seatColor);
    box(group, -0.25, 0.25, 0.52, options?.highBack ? 1.35 : 0.9, -0.3, -0.22, seatColor);
    box(group, -0.04, 0.04, 0, 0.42, -0.04, 0.04, CHAIR_BASE);
    box(group, -0.25, 0.25, 0, 0.05, -0.25, 0.25, CHAIR_BASE, { outline: false });
    scene.add(group);
  };

  const buildSofa = (prop: PropFootprint, color: number) => {
    const wide = prop.maxX - prop.minX > prop.maxZ - prop.minZ;
    box(scene, prop.minX, prop.maxX, 0, 0.42, prop.minZ, prop.maxZ, color);
    if (wide) box(scene, prop.minX, prop.maxX, 0.42, 0.85, prop.minZ, prop.minZ + 0.25, color);
    else box(scene, prop.minX, prop.minX + 0.25, 0.42, 0.85, prop.minZ, prop.maxZ, color);
  };

  const buildDecor = (id: string, minX: number, maxX: number, minZ: number, maxZ: number) => {
    const cx = mid(minX, maxX);
    const cz = mid(minZ, maxZ);
    if (id === "prop_bust") {
      box(scene, minX, maxX, 0, 1.0, minZ, maxZ, 0xeceae4);
      box(scene, cx - 0.2, cx + 0.2, 1.0, 1.5, cz - 0.2, cz + 0.2, 0xeceae4);
    } else if (id === "prop_credenza") {
      box(scene, minX, maxX, 0, 0.75, minZ, maxZ, WALNUT);
      box(scene, minX - 0.02, maxX + 0.02, 0.75, 0.8, minZ - 0.02, maxZ + 0.02, WALNUT_TOP);
      for (let i = 1; i < 4; i++) {
        const x = minX + (i * (maxX - minX)) / 4;
        box(scene, x - 0.01, x + 0.01, 0.1, 0.68, maxZ, maxZ + 0.01, 0x5e3721, { outline: false });
        box(scene, x - 0.12, x - 0.06, 0.4, 0.5, maxZ, maxZ + 0.03, BRASS, { outline: false });
      }
      // Model sailing ship: hull, three masts, cream sails, small stand
      const shipX = mid(minX + 0.6, minX + 1.8);
      box(scene, shipX - 0.08, shipX + 0.08, 0.8, 0.88, cz - 0.05, cz + 0.05, 0x5c3a24);
      box(scene, shipX - 0.55, shipX + 0.55, 0.88, 1.02, cz - 0.1, cz + 0.1, 0x8a5a3c);
      box(scene, shipX - 0.4, shipX + 0.45, 1.02, 1.05, cz - 0.08, cz + 0.08, 0xc98a4a, { outline: false });
      for (const [dx, h] of [[-0.3, 0.38], [0.02, 0.5], [0.32, 0.36]] as const) {
        box(scene, shipX + dx - 0.015, shipX + dx + 0.015, 1.05, 1.05 + h, cz - 0.015, cz + 0.015, 0x5c3a24, { outline: false });
        box(scene, shipX + dx - 0.13, shipX + dx + 0.13, 1.15, 1.0 + h, cz + 0.02, cz + 0.04, 0xf4ead2);
      }
      // Trophy cup on a black base
      const cupX = minX + 3.8;
      box(scene, cupX - 0.12, cupX + 0.12, 0.8, 0.9, cz - 0.12, cz + 0.12, 0x282a36);
      cylinder(scene, cupX, cz, 0.03, 0.9, 1.05, 0xe8b923);
      cylinder(scene, cupX, cz, 0.13, 1.05, 1.3, 0xe8b923);
      box(scene, cupX - 0.2, cupX - 0.13, 1.12, 1.24, cz - 0.02, cz + 0.02, 0xe8b923, { outline: false });
      box(scene, cupX + 0.13, cupX + 0.2, 1.12, 1.24, cz - 0.02, cz + 0.02, 0xe8b923, { outline: false });
      // Red vintage model car with chrome bumpers and wheels
      const carX = minX + 5.4;
      box(scene, carX - 0.4, carX + 0.4, 0.86, 0.98, cz - 0.15, cz + 0.15, 0xc3262e);
      box(scene, carX - 0.18, carX + 0.15, 0.98, 1.08, cz - 0.13, cz + 0.13, 0x8f1b22);
      box(scene, carX - 0.43, carX - 0.4, 0.86, 0.93, cz - 0.15, cz + 0.15, 0xd9dde2, { outline: false });
      box(scene, carX + 0.4, carX + 0.43, 0.86, 0.93, cz - 0.15, cz + 0.15, 0xd9dde2, { outline: false });
      for (const wx of [carX - 0.25, carX + 0.25]) box(scene, wx - 0.07, wx + 0.07, 0.8, 0.92, cz - 0.17, cz + 0.17, 0x282a36, { outline: false });
    } else if (id.startsWith("prop_armchair")) {
      // Chesterfield armchair: seat, back on the far side, rolled arms
      const facesEast = id.endsWith("_w");
      box(scene, minX, maxX, 0, 0.42, minZ, maxZ, LEATHER);
      if (facesEast) box(scene, minX, minX + 0.22, 0.42, 0.85, minZ, maxZ, 0x5c2a17);
      else box(scene, maxX - 0.22, maxX, 0.42, 0.85, minZ, maxZ, 0x5c2a17);
      box(scene, minX, maxX, 0.42, 0.66, minZ, minZ + 0.16, LEATHER);
      box(scene, minX, maxX, 0.42, 0.66, maxZ - 0.16, maxZ, LEATHER);
    } else if (id === "prop_globe") {
      cylinder(scene, cx, cz, 0.04, 0, 0.5, 0x5c3a24);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), material(0xc9b98a));
      disposables.push(ball.geometry);
      ball.position.set(cx, 0.9, cz);
      scene.add(ball);
    } else if (id === "prop_bar_island") {
      box(scene, minX, maxX, 0, 0.95, minZ, maxZ, 0xf2e4c9);
      box(scene, minX - 0.03, maxX + 0.03, 0.95, 1.0, minZ - 0.03, maxZ + 0.03, 0xe9a964);
    } else if (id === "prop_fridge") {
      box(scene, minX, maxX, 0, 2.0, minZ, maxZ, 0xc6d5da);
    } else if (id === "prop_ac_unit") {
      box(scene, minX, maxX, 0, 1.0, minZ, maxZ, 0xe8eef0);
    } else if (id === "prop_tv_cabinet") {
      box(scene, minX, maxX, 0, 0.5, minZ, maxZ, 0xa8693f);
      box(scene, minX + 0.4, maxX - 0.4, 0.5, 1.2, minZ, minZ + 0.1, 0x3d363e);
      box(scene, minX + 0.45, maxX - 0.45, 0.55, 1.15, minZ + 0.1, minZ + 0.12, 0x1f2430, { outline: false });
    } else if (id === "prop_floor_lamp") {
      box(scene, cx - 0.03, cx + 0.03, 0, 1.5, cz - 0.03, cz + 0.03, CHAIR_BASE);
      box(scene, cx - 0.2, cx + 0.2, 1.4, 1.6, cz - 0.2, cz + 0.2, 0xf3e3b5);
    } else if (id === "prop_coat_stand") {
      box(scene, cx - 0.04, cx + 0.04, 0, 1.7, cz - 0.04, cz + 0.04, WALNUT_TOP);
    } else if (id === "prop_bin") {
      box(scene, minX, maxX, 0, 0.5, minZ, maxZ, 0x2563eb);
    } else {
      box(scene, minX, maxX, 0, 0.9, minZ, maxZ, 0xdfe6ea);
    }
  };

  for (const furniture of OFFICE_PROPS) {
    const { id, kind, minX, maxX, minZ, maxZ, zone } = furniture;
    const cx = mid(minX, maxX);
    const cz = mid(minZ, maxZ);

    switch (kind) {
      case "meeting_table": {
        box(scene, minX, maxX, 0.85, 0.95, minZ, maxZ, 0xedb168);
        box(scene, minX + 0.1, maxX - 0.1, 0.7, 0.85, minZ + 0.1, maxZ - 0.1, 0xc98a4a);
        for (const [lx, lz] of [[minX + 0.2, minZ + 0.2], [maxX - 0.2, minZ + 0.2], [minX + 0.2, maxZ - 0.2], [maxX - 0.2, maxZ - 0.2]]) {
          box(scene, lx - 0.08, lx + 0.08, 0, 0.85, lz - 0.08, lz + 0.08, 0x8a5a3c);
        }
        // Laptops, papers and a mug
        box(scene, -16.8, -16.2, 0.95, 0.98, -5.6, -5.2, 0x334155);
        box(scene, -12.9, -12.1, 0.95, 0.98, -4.8, -4.4, 0x334155);
        box(scene, -14.9, -14.1, 0.95, 0.97, -5.2, -4.8, 0xf8fafc, { outline: false });
        box(scene, -11.4, -11.0, 0.95, 1.05, -5.6, -5.2, 0xef4444);
        break;
      }
      case "meeting_chair": {
        const seat = furniture.interactionPoints[0];
        if (!seat) break;
        const cushion = id === "prop_chair_chair_head" ? CUSHION_SLATE : id === "prop_chair_owner_head" ? CUSHION_ROSE : Math.round(seat.x + 20) % 2 === 0 ? CUSHION_ORANGE : TEAL;
        buildChair(seat.x, seat.z, seat.approachAngle, cushion);
        break;
      }
      case "workstation_desk": {
        box(scene, minX, maxX, 0.7, 0.75, minZ, maxZ, 0xe39f60);
        for (const [lx, lz] of [[minX + 0.1, minZ + 0.1], [maxX - 0.1, minZ + 0.1], [minX + 0.1, maxZ - 0.1], [maxX - 0.1, maxZ - 0.1]]) {
          box(scene, lx - 0.04, lx + 0.04, 0, 0.7, lz - 0.04, lz + 0.04, 0xb8bcc4);
        }
        // Monitor (screen glows #77eaff), keyboard and a desk lamp
        box(scene, cx - 0.3, cx + 0.3, 0.95, 1.25, cz - 0.4, cz - 0.35, 0x3a3d4a);
        box(scene, cx - 0.26, cx + 0.26, 1.0, 1.2, cz - 0.35, cz - 0.34, 0x77eaff, { outline: false });
        box(scene, cx - 0.2, cx + 0.2, 0.75, 0.78, cz - 0.05, cz + 0.1, 0xf8fafc);
        box(scene, maxX - 0.25, maxX - 0.2, 0.75, 1.1, minZ + 0.1, minZ + 0.15, 0xf0d27a);
        break;
      }
      case "workstation_chair": {
        if (id.startsWith("prop_guest_chair")) {
          buildChair(cx, cz, Math.PI, LEATHER, { leather: true });
          break;
        }
        const seat = furniture.interactionPoints[0];
        if (seat) buildChair(seat.x, seat.z, seat.approachAngle, CHAIR_SEAT);
        break;
      }
      case "director_desk": {
        box(scene, minX, maxX, 0.75, 0.8, minZ, maxZ, WALNUT_TOP);
        box(scene, minX + 0.1, maxX - 0.1, 0.4, 0.75, minZ + 0.1, maxZ - 0.1, WALNUT);
        const seat = furniture.interactionPoints[0];
        if (seat) buildChair(seat.x, seat.z, seat.approachAngle, LEATHER_DARK, { leather: true, highBack: true });
        // Banker's lamp, laptop, gold figurine, framed photo
        box(scene, minX + 0.45, minX + 0.6, 0.8, 1.25, minZ + 0.45, minZ + 0.6, BRASS);
        box(scene, minX + 0.25, minX + 0.8, 1.25, 1.4, minZ + 0.25, minZ + 0.8, 0x2f8f4e);
        box(scene, minX + 1.75, minX + 2.25, 0.8, 1.05, minZ + 0.4, minZ + 0.7, 0xcbd5e1);
        box(scene, minX + 1.1, minX + 1.3, 0.8, 1.02, minZ + 0.95, minZ + 1.15, BRASS);
        box(scene, minX + 3.3, minX + 3.5, 0.8, 1.0, minZ + 0.45, minZ + 0.65, BRASS);
        break;
      }
      case "bookshelf": {
        const bodyColor = zone === "director" ? 0x6b4029 : 0x805242;
        box(scene, minX, maxX, 0, 2.4, minZ, maxZ, bodyColor);
        const palette = [0xc3182a, 0x3b82f6, 0x64a83b, 0xf0c419, 0xb5651d, LEATHER];
        for (let shelf = 0; shelf < 4; shelf++) {
          const y = 1.0 + shelf * 0.4;
          for (let book = 0; book < 3; book++) {
            const z0 = minZ + 0.08 + book * ((maxZ - minZ - 0.16) / 3);
            box(scene, maxX, maxX + 0.02, y, y + 0.3, z0, z0 + 0.12, palette[(shelf + book) % palette.length]!, { outline: false });
          }
        }
        break;
      }
      case "sofa":
        buildSofa(furniture, zone === "director" ? LEATHER : TEAL);
        break;
      case "coffee_table":
        box(scene, minX, maxX, 0.36, 0.4, minZ, maxZ, zone === "director" ? WALNUT : 0xa8693f);
        break;
      case "bar": {
        box(scene, minX, maxX, 0, 1.0, minZ, maxZ, WALNUT);
        box(scene, minX - 0.05, maxX + 0.05, 1.0, 1.05, minZ - 0.05, maxZ + 0.05, WALNUT_TOP);
        box(scene, minX, maxX, 0.15, 0.16, maxZ, maxZ + 0.1, BRASS, { outline: false });
        // Decanter (glass), three bottles and the espresso machine
        box(scene, minX + 0.3, minX + 0.5, 1.05, 1.35, cz - 0.1, cz + 0.1, 0xe3f1f5);
        box(scene, minX + 0.8, minX + 0.95, 1.05, 1.4, cz - 0.1, cz + 0.1, 0xb5651d);
        box(scene, minX + 1.1, minX + 1.25, 1.05, 1.4, cz - 0.1, cz + 0.1, 0x3f6e3a);
        box(scene, minX + 1.4, minX + 1.55, 1.05, 1.4, cz - 0.1, cz + 0.1, 0xb5651d);
        box(scene, maxX - 0.7, maxX - 0.2, 1.05, 1.45, minZ + 0.1, maxZ - 0.1, 0x3d363e);
        break;
      }
      case "coffee_counter": {
        box(scene, minX, maxX, 0, 0.95, minZ, maxZ, 0xf2e4c9);
        box(scene, minX - 0.03, maxX + 0.03, 0.95, 1.0, minZ - 0.03, maxZ + 0.03, 0xe9a964);
        box(scene, minX + 0.3, minX + 0.7, 1.0, 1.35, minZ + 0.1, minZ + 0.4, 0x3d363e);
        box(scene, maxX - 0.5, maxX - 0.3, 1.0, 1.1, minZ + 0.1, minZ + 0.3, 0xb8bcc4, { outline: false });
        break;
      }
      case "water_cooler":
        box(scene, minX, maxX, 0, 1.3, minZ, maxZ, 0xeef2f4);
        cylinder(scene, cx, cz, 0.28, 1.3, 1.8, 0x4dbfe1);
        break;
      case "server_rack": {
        box(scene, minX, maxX, 0, 2.2, minZ, maxZ, 0x25252d);
        for (let y = 0.3; y < 2.1; y += 0.35) {
          box(scene, minX + 0.05, maxX - 0.05, y, y + 0.08, maxZ, maxZ + 0.02, Math.round(y * 10) % 2 === 0 ? 0x4ade80 : 0x38bdf8, { outline: false });
        }
        break;
      }
      case "printer":
        box(scene, minX, maxX, 0, 0.9, minZ, maxZ, 0xe8eef0);
        box(scene, minX + 0.1, maxX - 0.1, 0.9, 0.93, minZ + 0.1, maxZ - 0.1, 0x9aa3ab);
        break;
      case "plant": {
        const pot = zone === "director" ? BRASS : zone === "entrance" ? TEAL : TERRACOTTA;
        const tall = id === "prop_plant_fig" ? 1.9 : id === "prop_plant_monstera" ? 1.5 : zone === "director" ? 1.6 : 1.25;
        pottedPlant(cx, cz, Math.min(0.3, (maxX - minX) * 0.35), tall, pot);
        break;
      }
      case "reception":
        box(scene, minX, maxX, 0, 1.0, minZ, maxZ, 0xf2e4c9);
        box(scene, minX - 0.03, maxX + 0.03, 1.0, 1.05, minZ - 0.03, maxZ + 0.03, 0xe9a964);
        box(scene, cx - 0.2, cx + 0.2, 1.05, 1.35, cz - 0.2, cz - 0.15, CHAIR_BASE);
        break;
      case "bench":
        box(scene, minX, maxX, 0.42, 0.45, minZ, maxZ, 0xde985d);
        for (const lx of [minX + 0.2, maxX - 0.2]) box(scene, lx - 0.04, lx + 0.04, 0, 0.42, minZ + 0.1, maxZ - 0.1, CHAIR_BASE);
        break;
      case "decor":
        buildDecor(id, minX, maxX, minZ, maxZ);
        break;
      default:
        // Markers only carry interaction points
        break;
    }
  }

  // Stools at the kitchen island (grid 14.5 / 16 / 17.5, gz 17.7)
  for (const gx of [14.5, 16, 17.5]) {
    cylinder(scene, gx - 20, 17.7 - 10, 0.12, 0, 0.7, 0xd98f5e);
  }

  // Low teal dividers between the desk pairs (grid gz 4, gx 14–18 and 20–24). Desks already block walking.
  const dividerA = gridRect(14, 18, 4, 4);
  const dividerB = gridRect(20, 24, 4, 4);
  box(scene, dividerA.minX, dividerA.maxX, 0.3, 1.15, -6.05, -5.95, 0x6fa8b0);
  box(scene, dividerB.minX, dividerB.maxX, 0.3, 1.15, -6.05, -5.95, 0x6fa8b0);

  // Rugs: Persian under the director's desk, olive sitting corner, lounge rug
  gridBox(scene, 31.8, 37.8, 1.6, 6.6, 0, 0.02, 0xd4a537, { outline: false });
  gridBox(scene, 32.0, 37.6, 1.8, 6.4, 0, 0.025, 0x8e2b3a, { outline: false });
  gridBox(scene, 32.5, 37.1, 2.3, 5.9, 0, 0.03, 0x6e1f2c, { outline: false });
  gridBox(scene, 34.1, 35.5, 5.2, 5.8, 0, 0.035, 0x3e898e, { outline: false });
  gridBox(scene, 26.6, 31.6, 6.3, 9.8, 0, 0.02, 0x5e5636, { outline: false });
  gridBox(scene, 26.75, 31.45, 6.45, 9.65, 0, 0.025, 0x7a7046, { outline: false });

  // Gold-framed painting (north wall gx 28–30, y 1.8–2.9) and two diplomas (gx 26.95–27.65)
  box(scene, 8.0, 10.0, 1.8, 2.9, -10.0, -9.93, 0xe8b923);
  box(scene, 8.12, 9.88, 1.92, 2.78, -9.93, -9.92, 0xf0c070, { outline: false });
  box(scene, 8.12, 9.88, 1.92, 2.3, -9.92, -9.91, 0x9fcf7a, { outline: false });
  for (const [y0, y1] of [[1.45, 1.95], [2.15, 2.65]] as const) {
    box(scene, 6.95, 7.65, y0, y1, -10.0, -9.94, 0x6b4029);
    box(scene, 7.02, 7.58, y0 + 0.06, y1 - 0.06, -9.94, -9.93, 0xf4ead2, { outline: false });
    box(scene, 7.38, 7.48, y0 + 0.1, y0 + 0.2, -9.93, -9.92, 0xc3182a, { outline: false });
  }

  // Shelf statuettes facing the room: bronze horse, crystal obelisk, jade elephant
  box(scene, 6.62, 6.82, 1.62, 1.95, -6.95, -6.75, 0xb08d57);
  box(scene, 6.62, 6.78, 1.12, 1.42, -6.45, -6.35, 0xbfe9ff, { opacity: 0.8 });
  box(scene, 6.62, 6.85, 1.62, 1.85, -5.05, -4.75, 0x4f9a7a);
  gridBox(scene, 2, 7, 15, 18, 0, 0.02, 0xdc9a5d, { outline: false });

  // Lights: ambient plus one directional light from (1, 2, 0.35), no shadows (reference.md §4).
  // three.js lights are physical since r155: Lambert divides by π, so the intensities carry π back
  // and a lit top face shows its base colour.
  scene.add(new THREE.AmbientLight(0xffffff, 0.62 * Math.PI));
  const sun = new THREE.DirectionalLight(0xfff5ea, 0.45 * Math.PI);
  sun.position.set(1, 2, 0.35).multiplyScalar(10);
  scene.add(sun);
}
