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

  // ==========================================
  // 1. SLAB, GROUND, PAVING AND TREES
  // ==========================================
  scene.background = new THREE.Color(SKY);
  box(scene, -20, 20, -0.5, 0, -10, 10, SLAB, { outline: false });

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), material(GRASS));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  disposables.push(ground.geometry);
  scene.add(ground);

  // Paving from the entrance door and along the south edge, running out of frame
  box(scene, 21, 70, -0.52, -0.49, 5.5, 8.5, PAVING, { outline: false });
  box(scene, -30, 70, -0.52, -0.49, 11, 13, PAVING, { outline: false });

  for (const [x, z] of TREES) {
    box(scene, x - 0.15, x + 0.15, -0.5, 0.5, z - 0.15, z + 0.15, 0x8a5a3c);
    box(scene, x - 0.7, x + 0.7, 0.5, 1.9, z - 0.7, z + 0.7, 0x81b352);
  }

  // Street lamp at grid (43, 21)
  box(scene, 22.9, 23.1, -0.5, 1.8, 10.9, 11.1, 0x3a3d4a);
  box(scene, 22.7, 23.3, 1.8, 2.0, 10.7, 11.3, 0xf9e79f);

  // ==========================================
  // 2. FLOOR ZONES
  // ==========================================
  for (const zone of FLOOR_ZONES) {
    gridBox(scene, zone.gx0, zone.gx1, zone.gz0, zone.gz1, -0.04, 0, zone.color, { outline: false });
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

  // Windows on the north wall (gx 13–16, 17–20, 21–24) and the west wall (meeting gz 3–7, lounge gz 15–18)
  for (const [gx0, gx1] of [[13, 16], [17, 20], [21, 24]] as const) {
    box(scene, gx0 - 20, gx1 - 20, 0.9, 2.9, -10, -9.95, GLASS, { outline: false, opacity: 0.55 });
  }
  box(scene, -20, -19.95, 0.9, 2.9, -7, -3, GLASS, { outline: false, opacity: 0.55 });
  box(scene, -20, -19.95, 0.9, 2.9, 5, 8, GLASS, { outline: false, opacity: 0.55 });

  // Panoramic window in the director's office (gx 30.4–39.6): six panes, white mullions every 1.53
  box(scene, 10.4, 19.6, 0.6, 3.2, -10, -9.95, GLASS, { outline: false, opacity: 0.55 });
  for (let i = 0; i <= 6; i++) {
    const x = 10.4 + i * (9.2 / 6);
    box(scene, x - 0.05, x + 0.05, 0.6, 3.2, -10.02, -9.93, 0xffffff);
  }

  // Wall screen (north wall gx 4–8, y 1.3–2.6) and the whiteboard (west wall gz 7.5–10, y 1.0–2.3)
  box(scene, -16, -12, 1.3, 2.6, -10.1, -9.95, 0x2f3340);
  box(scene, -15.8, -12.2, 1.45, 2.45, -9.94, -9.9, 0x2b4a6b, { outline: false });
  box(scene, -20.1, -19.95, 1.0, 2.3, -2.5, 0, 0xffffff, { outline: false });
  box(scene, -20.0, -19.9, 1.8, 2.0, -2.3, -2.1, 0xf472b6);
  box(scene, -20.0, -19.9, 1.8, 2.0, -1.6, -1.4, 0xfef08a);
  box(scene, -20.0, -19.9, 1.8, 2.0, -0.9, -0.7, 0x67e8f9);

  // Interior walls from the layout: glass in the meeting room, walnut in the director's office, server grey in the server room
  for (const wall of OFFICE_WALLS) {
    if (wall.id.startsWith("wall_meeting")) {
      box(scene, wall.minX, wall.maxX, 0, 2.6, wall.minZ, wall.maxZ, 0xcfe6ee, { outline: false, opacity: 0.35 });
      box(scene, wall.minX, wall.maxX, 2.5, 2.6, wall.minZ, wall.maxZ, 0xf4f7f8);
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
      box(scene, minX + 0.6, minX + 1.8, 0.8, 1.4, minZ + 0.1, minZ + 0.4, 0x9b6b3a);
      box(scene, minX + 3.4, minX + 3.8, 0.8, 1.35, minZ + 0.2, minZ + 0.4, BRASS);
      box(scene, minX + 4.6, minX + 5.0, 0.8, 1.0, minZ + 0.2, minZ + 0.4, 0xc3262e);
    } else if (id.startsWith("prop_armchair")) {
      box(scene, minX, maxX, 0, 0.85, minZ, maxZ, LEATHER);
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
        const tall = zone === "director" ? 1.6 : 1.2;
        const half = (maxX - minX) * 0.4;
        box(scene, cx - half, cx + half, 0, 0.5, cz - half, cz + half, pot);
        box(scene, cx - half - 0.25, cx + half + 0.25, 0.5, tall, cz - half - 0.25, cz + half + 0.25, LEAF);
        box(scene, cx - 0.2, cx + 0.2, tall, tall + 0.3, cz - 0.2, cz + 0.2, LEAF_SHADE);
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
  gridBox(scene, 31.8, 37.8, 1.6, 6.6, 0, 0.02, 0x8e2b3a, { outline: false });
  gridBox(scene, 26.6, 31.6, 6.3, 9.8, 0, 0.02, 0x7a7046, { outline: false });
  gridBox(scene, 2, 7, 15, 18, 0, 0.02, 0xdc9a5d, { outline: false });

  // Lights: ambient plus one directional light from (1, 2, 0.35), no shadows (reference.md §4)
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const sun = new THREE.DirectionalLight(0xfff5ea, 0.45);
  sun.position.set(1, 2, 0.35).multiplyScalar(10);
  scene.add(sun);
}
