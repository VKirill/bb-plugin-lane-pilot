import type * as ThreeType from "three";
import type { PropsKit } from "@lane-pilot/pixel-world";

// Palette (reference.md §3) plus a few prop colours
const LEAF = 0x669e3b;
const LEAF_SHADE = 0x518530;
const TERRACOTTA = 0xce6b4e;
const TEAL = 0x3e898e;
const BRASS = 0xd4a537;
const WALNUT = 0x7b4a2e;
const WALNUT_TOP = 0x8f5a38;
const DARK = 0x3a3d4a;
const STEEL = 0xb8bcc4;
const WHITE = 0xf8fafc;
const CREAM = 0xf4ead2;
const PAVING = 0xc1bcc0;
const JOINT = 0x8f8a92;
const GRASS = 0x93c06b;
const ASPHALT = 0x5f5e68;
const STONE = 0xd3ced4;

/** Small deterministic pseudo-random in [0, 1) for scattering flowers and leaves. */
const rnd = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Extra props, part B: kitchen, lounge, server room, entrance and the exterior lot.
 * Floor-standing indoor props are listed in office-blockers-b.ts.
 */
export function buildPropsB(kit: PropsKit): void {
  const { THREE, scene, box, blob, cylinder, material, disposables } = kit;
  kit.setPart("props-b");

  const X = (gx: number) => gx - 20;
  const Z = (gz: number) => gz - 10;
  /** Unoutlined 8-sided cylinder, named for the geometry audit. */
  const cyl = (x: number, z: number, r: number, y0: number, y1: number, c: number) => {
    const m = cylinder(scene, x, z, r, y0, y1, c);
    m.name = "props-b:cyl";
    return m;
  };
  /** Outlined box in world units. */
  const ob = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number, parent: ThreeType.Object3D = scene) =>
    box(parent, x0, x1, y0, y1, z0, z1, c);
  /** Unoutlined box in world units. */
  const nb = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: number, parent: ThreeType.Object3D = scene) =>
    box(parent, x0, x1, y0, y1, z0, z1, c, { outline: false });
  /** Outlined / unoutlined boxes on grid coordinates (gx0, gx1, gz0, gz1, y0, y1). */
  const gb = (gx0: number, gx1: number, gz0: number, gz1: number, y0: number, y1: number, c: number) =>
    box(scene, X(gx0), X(gx1), y0, y1, Z(gz0), Z(gz1), c);
  const gn = (gx0: number, gx1: number, gz0: number, gz1: number, y0: number, y1: number, c: number) =>
    box(scene, X(gx0), X(gx1), y0, y1, Z(gz0), Z(gz1), c, { outline: false });
  /** Round cylinder on grid coordinates. */
  const gcyl = (gx: number, gz: number, r: number, y0: number, y1: number, c: number) => cyl(X(gx), Z(gz), r, y0, y1, c);

  /** Flat disc whose face looks along +X (logo shapes on partitions). */
  const disc = (x: number, y: number, z: number, r: number, thick: number, c: number) => {
    const geom = new THREE.CylinderGeometry(r, r, thick, 20);
    disposables.push(geom);
    const m = new THREE.Mesh(geom, material(c));
    m.name = "props-b";
    m.rotation.z = Math.PI / 2;
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };

  /** Group placed at (x, y, z) and turned about Y; its local coordinates feed `ob`/`nb`. */
  const place = (x: number, y: number, z: number, rotY = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    scene.add(g);
    return g;
  };

  /** Potted plant: pot, soil and three leaf balls, `h` = total height. */
  const plant = (x: number, z: number, half: number, h: number, pot: number, y0 = 0, shade = LEAF) => {
    ob(x - half, x + half, y0, y0 + 0.4, z - half, z + half, pot);
    nb(x - half + 0.04, x + half - 0.04, y0 + 0.4, y0 + 0.42, z - half + 0.04, z + half - 0.04, 0x5a3d2b);
    const base = y0 + 0.42;
    const span = h - 0.42;
    blob(scene, x, base + span * 0.35, z, half * 1.7, shade, 1.1);
    blob(scene, x + half * 0.5, base + span * 0.65, z - half * 0.3, half * 1.35, LEAF, 1.1);
    blob(scene, x - half * 0.3, base + span * 0.9, z + half * 0.3, half * 1.05, 0x7fb74a, 1.1);
  };

  /** Cushion leaning on a sofa back, tilted about X (z-backed) or Z (x-backed). */
  const cushion = (x: number, y: number, z: number, c: number, tiltX: number, tiltZ: number) => {
    const g = place(x, y, z);
    g.rotation.x = tiltX;
    g.rotation.z = tiltZ;
    ob(-0.17, 0.17, 0, 0.32, -0.06, 0.06, c, g);
  };

  kit.setPart("props-b:lounge");
  // ==========================================
  // LOUNGE (gx 0–11, gz 13–20)
  // ==========================================
  // Rug pattern over the rug (gx 2–7 × gz 15–18, top y 0.02): border, field, nested diamonds
  const RUG_EDGE = 0xb8683a;
  gn(2.1, 6.9, 15.1, 15.25, 0, 0.026, RUG_EDGE);
  gn(2.1, 6.9, 17.75, 17.9, 0, 0.026, RUG_EDGE);
  gn(2.1, 2.25, 15.25, 17.75, 0, 0.026, RUG_EDGE);
  gn(6.75, 6.9, 15.25, 17.75, 0, 0.026, RUG_EDGE);
  gn(2.4, 6.6, 15.4, 17.6, 0, 0.03, 0xf0c79a);
  const diamond = (gx: number, gz: number, half: number, top: number, c: number) => {
    const g = place(X(gx), 0, Z(gz), Math.PI / 4);
    nb(-half, half, 0, top, -half, half, c, g);
  };
  diamond(4.5, 16.5, 0.85, 0.036, TEAL);
  diamond(4.5, 16.5, 0.58, 0.042, CREAM);
  diamond(4.5, 16.5, 0.28, 0.048, TERRACOTTA);

  // TV console: game console, controllers, speakers, books, drawer knobs
  gb(2.5, 3.3, 13.42, 13.74, 0.5, 0.57, 0xe8eef0);
  gn(2.55, 3.1, 13.74, 13.745, 0.51, 0.55, 0x4ade80);
  gb(3.5, 4.15, 13.45, 13.72, 0.5, 0.55, 0x3d363e);
  gn(3.8, 3.95, 13.72, 13.725, 0.52, 0.53, 0x38bdf8);
  gb(4.3, 4.62, 13.4, 13.7, 0.5, 0.56, 0xc3262e);
  gb(4.32, 4.6, 13.42, 13.68, 0.56, 0.61, 0x3b82f6);
  gn(3.35, 3.5, 13.5, 13.62, 0.5, 0.53, 0x1f2430);
  for (const x0 of [2.05, 4.65]) {
    gb(x0, x0 + 0.3, 13.25, 13.55, 0.5, 1.0, DARK);
    gn(x0 + 0.08, x0 + 0.22, 13.55, 13.56, 0.62, 0.76, 0x8b93a1);
    gn(x0 + 0.1, x0 + 0.2, 13.55, 13.56, 0.82, 0.9, 0x6b7280);
  }
  for (const x of [3.0, 4.0]) gn(x - 0.01, x + 0.01, 13.8, 13.81, 0.05, 0.45, 0x7a4528);
  for (const x of [2.5, 3.5, 4.5]) gn(x - 0.06, x + 0.06, 13.8, 13.84, 0.22, 0.28, BRASS);

  // Top of the lounge bookshelf: a plant pot, a flat stack of books and a framed photo
  gb(5.65, 5.95, 13.35, 13.65, 1.6, 1.8, TERRACOTTA);
  blob(scene, X(5.8), 2.0, Z(13.5), 0.2, LEAF, 1.1);
  blob(scene, X(5.72), 2.18, Z(13.5), 0.12, 0x7fb74a, 1.1);
  gb(6.15, 6.8, 13.3, 13.6, 1.6, 1.68, 0x3b82f6);
  gb(6.2, 6.75, 13.32, 13.58, 1.68, 1.75, 0xf0c419);
  gb(6.25, 6.7, 13.34, 13.56, 1.75, 1.81, 0xc3182a);
  gb(6.4, 6.75, 13.5, 13.54, 1.81, 2.05, 0xe8b923);
  gn(6.43, 6.72, 13.54, 13.545, 1.84, 2.02, 0x9fcf7a);

  // Side table with a lamp between the sofas
  for (const [gx, gz] of [[6.72, 18.52], [7.22, 18.52], [6.72, 19.02], [7.22, 19.02]] as const) gb(gx - 0.04, gx + 0.04, gz - 0.04, gz + 0.04, 0, 0.5, WALNUT);
  gb(6.65, 7.35, 18.45, 19.15, 0.5, 0.56, WALNUT_TOP);
  gcyl(7.0, 18.8, 0.1, 0.56, 0.6, BRASS);
  gcyl(7.0, 18.8, 0.03, 0.6, 0.85, BRASS);
  gb(6.82, 7.18, 18.62, 18.98, 0.85, 1.12, 0xf9e79f);
  gn(6.85, 7.15, 18.65, 18.95, 1.12, 1.14, 0xf0d27a);
  // A book and a mug on the side table
  gb(6.72, 6.92, 18.95, 19.1, 0.56, 0.6, 0x3b82f6);

  // Magazine rack next to the bookshelf
  gb(7.15, 7.85, 13.15, 13.65, 0, 0.06, WALNUT);
  gb(7.15, 7.2, 13.15, 13.65, 0.06, 0.85, WALNUT);
  gb(7.8, 7.85, 13.15, 13.65, 0.06, 0.85, WALNUT);
  gb(7.2, 7.8, 13.6, 13.65, 0.06, 0.85, 0x5e3721);
  gb(7.2, 7.8, 13.15, 13.2, 0.06, 0.5, 0x5e3721);
  [0xef4444, 0x38bdf8, 0xf0c419, 0x4ade80, 0xf48fb1].forEach((c, i) => {
    const gx = 7.22 + i * 0.115;
    gn(gx, gx + 0.1, 13.2, 13.28, 0.08 + (i % 2) * 0.04, 0.5 + (i % 2) * 0.28, c);
  });

  // Beanbags
  blob(scene, X(1.55), 0.38, Z(18.2), 0.5, 0xcb614b, 0.75);
  blob(scene, X(1.5), 0.62, Z(18.15), 0.3, 0xe07a63, 0.7);
  blob(scene, X(1.47), 0.34, Z(14.9), 0.46, 0x3e898e, 0.75);
  blob(scene, X(1.45), 0.56, Z(14.85), 0.28, 0x57a6ab, 0.7);

  // Cushions and blankets on the sofas (sofa A faces north, back at gz 18.95; sofa B faces west, back at gx 8.35)
  cushion(X(2.95), 0.5, Z(18.72), 0xf0c419, 0.28, 0);
  cushion(X(3.3), 0.5, Z(18.75), 0xe11d48, 0.3, 0);
  cushion(X(6.05), 0.5, Z(18.72), 0xcb614b, 0.28, 0);
  for (const [gz, c] of [[15.45, 0xf0c419], [17.55, 0xe11d48]] as const) {
    const g = place(X(8.2), 0.5, Z(gz));
    g.rotation.z = -0.28;
    ob(-0.06, 0.06, 0, 0.32, -0.17, 0.17, c, g);
  }
  gb(6.25, 6.54, 18.3, 18.9, 0.6, 0.65, 0xe8b923);
  gn(6.25, 6.54, 18.45, 18.52, 0.65, 0.655, 0xcb614b);
  gn(6.25, 6.54, 18.66, 18.73, 0.65, 0.655, 0xcb614b);
  gb(6.51, 6.57, 18.3, 18.9, 0.34, 0.645, 0xe8b923);
  gb(7.65, 8.25, 15.03, 15.2, 0.6, 0.65, 0x7ab6c4);
  gb(7.65, 8.25, 15.2, 15.26, 0.4, 0.65, 0x7ab6c4);

  // Lounge coffee table: vase with flowers, a mug
  gcyl(3.78, 16.7, 0.07, 0.4, 0.55, 0xe3f1f5);
  blob(scene, X(3.78), 0.64, Z(16.7), 0.1, 0xf48fb1, 1);
  blob(scene, X(3.7), 0.6, Z(16.68), 0.07, 0xf6f0f6, 1);
  gcyl(5.2, 16.65, 0.06, 0.4, 0.5, 0xffffff);

  // Guitar leaning on the west wall (inner face x = −20)
  {
    const g = place(X(0.45), 0, Z(14.5));
    g.rotation.z = 0.12;
    ob(-0.05, 0.05, 0.02, 0.38, -0.19, 0.19, 0xc98a4a, g);
    ob(-0.05, 0.05, 0.38, 0.6, -0.14, 0.14, 0xc98a4a, g);
    nb(0.05, 0.06, 0.26, 0.38, -0.07, 0.07, 0x282a36, g);
    ob(-0.03, 0.03, 0.6, 1.12, -0.03, 0.03, 0x5c3a24, g);
    ob(-0.04, 0.04, 1.12, 1.26, -0.045, 0.045, 0x3a3d4a, g);
  }

  // Wall art on the west wall: one abstract canvas on the lounge side, a triptych further south
  {
    const frame = (z0: number, z1: number, y0: number, y1: number, bg: number) => {
      ob(-20.02, -19.94, y0, y1, z0, z1, 0xf4f1ea);
      nb(-19.97, -19.935, y0 + 0.07, y1 - 0.07, z0 + 0.07, z1 - 0.07, bg);
    };
    frame(3.3, 4.8, 1.55, 2.55, 0xf0c79a);
    nb(-19.935, -19.925, 1.8, 2.3, 3.55, 4.05, TEAL);
    nb(-19.935, -19.925, 1.7, 2.1, 4.1, 4.5, TERRACOTTA);
    nb(-19.935, -19.925, 2.1, 2.4, 4.2, 4.55, 0xe8b923);
    const tri: Array<[number, number]> = [[8.25, 0x3e898e], [8.8, 0xcb614b], [9.35, 0xe8b923]];
    tri.forEach(([z0, c], i) => {
      frame(z0, z0 + 0.45, 1.5, 2.35, 0xf4ead2);
      nb(-19.935, -19.925, 1.7 + i * 0.1, 2.15, z0 + 0.1, z0 + 0.35, c);
    });
  }

  kit.setPart("props-b:kitchen");
  // ==========================================
  // KITCHEN (gx 11–21, gz 13–20)
  // ==========================================
  // Counter top (y 1.0): toaster, kettle, coffee bag, jar, cup stack neighbour, fruit bowl, knobs on the doors
  gb(14.9, 15.35, 13.45, 13.78, 1.0, 1.17, STEEL);
  gn(15.0, 15.25, 13.52, 13.7, 1.17, 1.18, DARK);
  gcyl(15.65, 13.6, 0.13, 1.0, 1.28, 0xc3262e);
  gcyl(15.65, 13.6, 0.05, 1.28, 1.34, DARK);
  gb(15.78, 15.9, 13.57, 13.63, 1.1, 1.25, DARK);
  gb(16.82, 17.06, 13.5, 13.78, 1.0, 1.3, 0x7b4a2e);
  gn(16.86, 17.02, 13.78, 13.785, 1.08, 1.22, CREAM);
  gcyl(17.18, 13.6, 0.09, 1.0, 1.26, 0xd9c7a0);
  gcyl(17.18, 13.6, 0.1, 1.26, 1.3, WALNUT);
  gcyl(17.85, 13.58, 0.17, 1.0, 1.07, 0xe8eef0);
  gn(17.74, 17.88, 13.5, 13.64, 1.07, 1.2, 0xe8523f);
  gn(17.84, 17.97, 13.55, 13.68, 1.07, 1.19, 0xf2a43a);
  gn(17.78, 17.9, 13.6, 13.72, 1.19, 1.3, 0xb8d65a);
  for (let i = 0; i < 8; i++) gn(14.38 + i * 0.5, 14.44 + i * 0.5, 13.9, 13.93, 0.55, 0.65, BRASS);

  // Fridge: microwave on top, magnets, drawing, calendar and a menu on the front (gz 14.0)
  gb(18.3, 19.1, 13.25, 13.95, 2.0, 2.35, 0xeeeeee);
  gn(18.35, 18.85, 13.95, 13.965, 2.07, 2.28, 0x2b2f3a);
  gn(18.9, 19.05, 13.95, 13.965, 2.07, 2.28, 0x9aa3ab);
  gn(18.95, 19.0, 13.965, 13.97, 2.2, 2.25, 0x4ade80);
  gn(18.35, 18.6, 14.0, 14.015, 1.15, 1.4, 0xf48fb1);
  gn(18.7, 18.95, 14.0, 14.015, 1.4, 1.8, WHITE);
  gn(18.7, 18.95, 14.015, 14.025, 1.68, 1.8, 0xc3262e);
  gn(18.66, 18.9, 14.0, 14.015, 0.9, 1.12, 0x7ab6c4);
  gn(18.76, 18.84, 14.015, 14.035, 1.6, 1.66, 0x3b82f6);

  // Water crate with a jug in front of the cooler (the cooler spot at gz 14.6 stays free)
  gb(19.65, 20.02, 14.04, 14.32, 0, 0.26, 0x3b6fb6);
  gcyl(19.84, 14.18, 0.1, 0.26, 0.6, 0x4dbfe1);
  gcyl(19.84, 14.18, 0.045, 0.6, 0.66, 0xeef2f4);

  // Island: mugs, fruit bowl, a cake under a stand
  gcyl(14.7, 16.3, 0.07, 1.0, 1.12, 0xffffff);
  gcyl(15.3, 16.72, 0.07, 1.0, 1.12, 0xcb614b);
  gcyl(17.25, 16.3, 0.07, 1.0, 1.12, TEAL);
  gcyl(16.1, 16.5, 0.26, 1.0, 1.08, 0xd9a441);
  gn(15.9, 16.08, 16.38, 16.54, 1.08, 1.22, 0xe8523f);
  gn(16.08, 16.25, 16.45, 16.6, 1.08, 1.2, 0xf2a43a);
  gn(16.0, 16.15, 16.5, 16.64, 1.2, 1.31, 0xb8d65a);
  gn(15.95, 16.1, 16.36, 16.5, 1.22, 1.32, 0xe8523f);
  gcyl(17.3, 16.7, 0.2, 1.0, 1.05, WHITE);
  gcyl(17.3, 16.7, 0.15, 1.05, 1.22, 0xf4ead2);
  gn(17.27, 17.33, 16.67, 16.73, 1.22, 1.3, 0xc3262e);
  // Kitchen runner in front of the counter
  gn(14.3, 17.7, 14.1, 14.8, 0, 0.012, 0x5b8c85);
  gn(14.35, 17.65, 14.15, 14.2, 0.012, 0.016, 0xd9e6e1);
  gn(14.35, 17.65, 14.7, 14.75, 0.012, 0.016, 0xd9e6e1);

  // Dining table with two chairs
  for (const [gx, gz] of [[18.95, 17.1], [20.05, 17.1], [18.95, 17.7], [20.05, 17.7]] as const) gb(gx - 0.04, gx + 0.04, gz - 0.04, gz + 0.04, 0, 0.7, DARK);
  gb(18.8, 20.2, 16.95, 17.85, 0.7, 0.76, 0xe9a964);
  gcyl(19.5, 17.4, 0.08, 0.76, 0.88, TERRACOTTA);
  blob(scene, X(19.5), 1.0, Z(17.4), 0.14, LEAF, 1.1);
  gcyl(19.1, 17.55, 0.06, 0.76, 0.86, 0xffffff);
  gcyl(19.95, 17.25, 0.06, 0.76, 0.86, 0xe11d48);
  const chair = (gx: number, gz: number, backSide: -1 | 1, c: number) => {
    for (const dx of [-0.2, 0.2]) gb(gx + dx - 0.03, gx + dx + 0.03, gz + 0.2 - 0.03, gz + 0.2 + 0.03, 0, 0.4, DARK);
    gb(gx - 0.25, gx + 0.25, gz - 0.25, gz + 0.25, 0.4, 0.47, c);
    const bz0 = backSide < 0 ? gz - 0.25 : gz + 0.19;
    gb(gx - 0.25, gx + 0.25, bz0, bz0 + 0.06, 0.47, 0.92, c);
  };
  chair(19.5, 16.3, -1, TEAL);
  chair(19.5, 18.5, 1, 0xcb614b);

  // Notice board on the lounge/kitchen partition (kitchen face x = gx 11.15)
  gb(11.14, 11.2, 15.2, 17.4, 0.62, 1.32, WALNUT);
  gn(11.2, 11.215, 15.28, 17.32, 0.7, 1.24, 0xc8935a);
  [[15.4, 0.95, 0xf8fafc], [15.8, 1.05, 0xf0c419], [16.15, 0.85, 0xf48fb1], [16.5, 1.0, 0x7ab6c4], [16.85, 0.9, 0xf8fafc], [15.55, 0.78, 0x4ade80], [16.95, 1.08, 0xf0c419]]
    .forEach(([gz, y, c], i) => gn(11.215, 11.222 + i * 0.002, (gz as number), (gz as number) + 0.26, y as number, (y as number) + 0.2, c as number));

  // Recycling bins: yellow, green, grey
  [[12.0, 0xf0c419], [12.5, 0x3f9e4a], [13.0, 0x64748b]].forEach(([gx, c]) => {
    gb(gx as number, (gx as number) + 0.4, 19.2, 19.7, 0, 0.58, c as number);
    gb((gx as number) - 0.02, (gx as number) + 0.42, 19.18, 19.72, 0.58, 0.64, DARK);
    gn((gx as number) + 0.12, (gx as number) + 0.28, 19.7, 19.71, 0.25, 0.4, WHITE);
  });

  // Tall plant next to the kitchen doorway
  plant(X(11.48), Z(15.22), 0.2, 1.7, TEAL);

  kit.setPart("props-b:server");
  // ==========================================
  // SERVER ROOM (gx 21–28, gz 13–20)
  // ==========================================
  // Rack tags and label strips; cables along the floor in front of the racks
  [[21.6, 22.8], [23.0, 24.2], [24.4, 25.6]].forEach(([a, b], r) => {
    for (let k = 0; k < 4; k += 2) {
      const c = [0xef4444, 0xf0c419, 0x38bdf8, 0x4ade80][(r + k) % 4]!;
      gn(a + 0.1, a + 0.3 + (k % 3) * 0.15, 14.5, 14.51, 0.49 + k * 0.35, 0.55 + k * 0.35, c);
      gn(b - 0.3, b - 0.1, 14.5, 14.51, 0.52 + k * 0.35, 0.57 + k * 0.35, WHITE);
    }
  });
  [[13.55, 0xef4444], [13.85, 0xf0c419], [14.1, 0x38bdf8]].forEach(([gz, c], i) => {
    gn(25.6, 25.615, (gz as number), (gz as number) + 0.16, 0.5 + i * 0.25, 0.6 + i * 0.25, c as number);
  });
  const cables: Array<[number, number, number, number]> = [
    [21.9, 25.3, 14.6, 0x25252d],
    [22.3, 24.9, 14.68, 0x38bdf8],
    [21.7, 24.1, 14.76, 0xf0c419],
    [23.2, 25.4, 14.84, 0xef4444],
  ];
  for (const [a, b, gz, c] of cables) gb(a, b, gz, gz + 0.06, 0, 0.05, c);
  gb(21.9, 21.96, 14.5, 14.6, 0, 0.056, 0x25252d);
  gb(24.9, 24.96, 14.6, 14.68, 0, 0.058, 0x38bdf8);
  gb(22.4, 22.46, 14.6, 14.76, 0, 0.06, 0xf0c419);
  gb(25.4, 25.46, 14.5, 14.84, 0, 0.062, 0xef4444);
  // Warning tape on the floor in front of the cable zone
  gn(21.3, 26.0, 15.9, 16.05, 0, 0.008, 0xf0c419);
  for (let gx = 21.4; gx < 25.9; gx += 0.4) gn(gx, gx + 0.2, 15.92, 16.03, 0, 0.014, DARK);
  gn(26.0, 26.15, 15.9, 16.05, 0, 0.008, 0xf0c419);

  // Crash cart with a monitor
  for (const [gx, gz] of [[24.95, 16.25], [25.55, 16.25], [24.95, 16.85], [25.55, 16.85]] as const) {
    gb(gx - 0.025, gx + 0.025, gz - 0.025, gz + 0.025, 0.08, 0.85, DARK);
    gn(gx - 0.05, gx + 0.05, gz - 0.05, gz + 0.05, 0, 0.08, 0x1f2430);
  }
  gb(24.9, 25.6, 16.2, 16.9, 0.85, 0.9, STEEL);
  gb(24.9, 25.6, 16.2, 16.9, 0.25, 0.28, STEEL);
  gb(25.0, 25.35, 16.4, 16.8, 0.28, 0.5, 0xc3262e);
  gb(25.12, 25.38, 16.45, 16.55, 0.9, 1.0, DARK);
  gb(24.95, 25.55, 16.42, 16.48, 1.0, 1.42, 0x2f3340);
  gn(25.0, 25.5, 16.48, 16.485, 1.05, 1.37, 0x1e6f5c);
  gn(25.05, 25.3, 16.485, 16.49, 1.2, 1.24, 0x4ade80);
  gn(25.05, 25.4, 16.55, 16.5 + 0.2, 0.9, 0.93, WHITE);

  // UPS cabinet and network rack along the east wall
  gb(27.0, 27.8, 15.6, 16.6, 0, 1.4, 0x3d4252);
  gn(27.0, 27.8, 16.6, 16.61, 0, 0.18, 0xf0c419);
  gn(27.2, 27.35, 16.605, 16.615, 0, 0.18, DARK);
  gn(27.5, 27.65, 16.605, 16.615, 0, 0.18, DARK);
  gn(27.15, 27.65, 16.6, 16.61, 1.0, 1.25, 0x9fe3b4);
  gn(27.2, 27.35, 16.61, 16.615, 1.08, 1.17, 0x1f2430);
  for (let i = 0; i < 4; i++) gn(27.15 + i * 0.13, 27.23 + i * 0.13, 16.6, 16.61, 0.8, 0.88, [0x4ade80, 0x4ade80, 0xf0c419, 0xef4444][i]!);
  gb(27.05, 27.75, 16.75, 17.75, 0, 1.8, 0x25252d);
  for (let k = 0; k < 7; k++) {
    gn(27.12, 27.68, 17.75, 17.77, 0.25 + k * 0.2, 0.37 + k * 0.2, k % 2 ? 0x374151 : 0x6b7280);
    gn(27.16 + (k % 3) * 0.1, 27.22 + (k % 3) * 0.1, 17.77, 17.78, 0.28 + k * 0.2, 0.34 + k * 0.2, [0x38bdf8, 0xf0c419, 0x4ade80][k % 3]!);
    gn(27.55, 27.62, 17.77, 17.78, 0.28 + k * 0.2, 0.34 + k * 0.2, k % 2 ? 0x4ade80 : 0x38bdf8);
  }

  // Fire extinguisher and a warning sign on the kitchen/server wall (server face x = gx 21.15)
  gcyl(21.32, 17.3, 0.09, 0.5, 1.05, 0xc3262e);
  gcyl(21.32, 17.3, 0.045, 1.05, 1.15, DARK);
  gn(21.15, 21.2, 17.2, 17.4, 0.95, 1.0, DARK);
  {
    const g = place(X(21.16), 1.18, Z(16.6));
    g.rotation.x = Math.PI / 4;
    nb(-0.01, 0.01, -0.17, 0.17, -0.17, 0.17, 0xf0c419, g);
    nb(0.01, 0.02, -0.1, 0.04, -0.015, 0.015, DARK, g);
    nb(0.01, 0.02, 0.07, 0.11, -0.02, 0.02, DARK, g);
  }

  // Spare-parts boxes
  gb(21.25, 21.95, 19.1, 19.8, 0, 0.45, 0xc99a5b);
  gb(21.3, 21.8, 19.15, 19.65, 0.45, 0.8, 0xd2a96a);
  gn(21.5, 21.6, 19.15, 19.65, 0.8, 0.805, 0xf3e3b5);
  gn(21.25, 21.95, 19.8, 19.805, 0.2, 0.28, 0xf3e3b5);
  gb(21.25, 21.7, 18.55, 19.0, 0, 0.3, 0xe8eef0);
  gn(21.25, 21.7, 19.0, 19.005, 0.1, 0.2, 0x3b82f6);

  kit.setPart("props-b:entrance");
  // ==========================================
  // ENTRANCE (gx 28–40, gz 13–20)
  // ==========================================
  // Abstract logo shape on the server/entrance partition (entrance face x = gx 28.15)
  disc(X(28.175), 0.92, Z(15.95), 0.38, 0.04, TEAL);
  disc(X(28.215), 0.76, Z(16.45), 0.26, 0.04, TERRACOTTA);
  disc(X(28.255), 1.0, Z(16.6), 0.14, 0.04, 0xf0c419);
  gn(28.15, 28.19, 15.45, 17.1, 0.5, 0.56, 0xf4ead2);

  // Mail cabinet with pigeonholes
  gb(28.2, 28.7, 13.8, 15.2, 0, 1.3, 0x8fa3aa);
  gn(28.701, 28.706, 13.85, 15.15, 0.05, 1.25, 0x5f7480);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      gn(28.706, 28.72, 13.88 + c * 0.42, 14.22 + c * 0.42, 0.12 + r * 0.28, 0.32 + r * 0.28, 0x2f3d46);
    }
  }

  // Water dispenser
  gb(28.2, 28.7, 17.3, 17.9, 0, 1.1, 0xe8eef0);
  gcyl(28.45, 17.6, 0.2, 1.1, 1.55, 0x4dbfe1);
  gcyl(28.45, 17.6, 0.08, 1.55, 1.62, 0x9ee3f5);
  gn(28.7, 28.74, 17.4, 17.5, 0.78, 0.86, 0xef4444);
  gn(28.7, 28.74, 17.7, 17.8, 0.78, 0.86, 0x38bdf8);
  gn(28.7, 28.76, 17.35, 17.85, 0.55, 0.6, 0x6b7280);

  // Reception desk: flowers, bell, tablet, pen cup (top y 1.05)
  gcyl(31.5, 14.25, 0.1, 1.05, 1.25, 0xe3f1f5);
  blob(scene, X(31.5), 1.4, Z(14.25), 0.17, 0xf48fb1, 1);
  blob(scene, X(31.4), 1.35, Z(14.2), 0.12, 0xf6f0f6, 1);
  blob(scene, X(31.6), 1.34, Z(14.3), 0.11, 0xe8b923, 1);
  gcyl(31.55, 16.75, 0.09, 1.05, 1.11, BRASS);
  gcyl(31.55, 16.75, 0.02, 1.11, 1.15, BRASS);
  gb(31.1, 31.4, 15.7, 16.0, 1.05, 1.07, DARK);
  gn(31.13, 31.37, 15.73, 15.97, 1.07, 1.075, 0x77eaff);
  gcyl(31.85, 14.5, 0.07, 1.05, 1.17, 0x3b82f6);

  // Waiting nook: rug, sofa, armchair, coffee table with magazines and a plant
  gn(31.6, 34.6, 17.6, 19.3, 0, 0.012, 0xb8683a);
  gn(31.7, 34.5, 17.7, 19.2, 0.012, 0.016, 0xf0c79a);
  gn(32.0, 34.2, 17.85, 19.05, 0.016, 0.02, TEAL);
  const SOFA = 0x5b7fa6;
  const SOFA_SHADE = 0x45658a;
  gb(31.9, 34.3, 18.9, 19.75, 0.05, 0.38, SOFA_SHADE);
  gb(31.9, 34.3, 19.5, 19.75, 0.38, 0.85, SOFA);
  gb(31.91, 32.12, 18.91, 19.5, 0.38, 0.6, SOFA);
  gb(34.08, 34.29, 18.91, 19.5, 0.38, 0.6, SOFA);
  gb(32.14, 33.08, 18.94, 19.47, 0.38, 0.5, SOFA);
  gb(33.12, 34.06, 18.94, 19.47, 0.38, 0.5, SOFA);
  cushion(X(32.45), 0.5, Z(19.35), 0xf0c419, 0.28, 0);
  cushion(X(33.8), 0.5, Z(19.35), 0xcb614b, 0.28, 0);
  const ARM = 0xd9a441;
  gb(30.1, 30.95, 18.1, 18.95, 0.05, 0.38, 0xb5841f);
  gb(30.1, 30.32, 18.1, 18.95, 0.38, 0.85, ARM);
  gb(30.33, 30.95, 18.1, 18.26, 0.38, 0.6, ARM);
  gb(30.33, 30.95, 18.79, 18.95, 0.38, 0.6, ARM);
  gb(30.35, 30.93, 18.28, 18.77, 0.38, 0.5, ARM);
  for (const [gx, gz] of [[32.45, 17.9], [33.75, 17.9], [32.45, 18.5], [33.75, 18.5]] as const) gb(gx - 0.04, gx + 0.04, gz - 0.04, gz + 0.04, 0, 0.36, WALNUT);
  gb(32.35, 33.85, 17.85, 18.55, 0.36, 0.4, 0xa8693f);
  gn(32.5, 32.9, 18.0, 18.3, 0.4, 0.42, 0xf48fb1);
  gn(32.62, 33.0, 18.1, 18.4, 0.42, 0.44, 0x81d4fa);
  gcyl(33.5, 18.2, 0.07, 0.4, 0.52, TERRACOTTA);
  blob(scene, X(33.5), 0.62, Z(18.2), 0.12, LEAF, 1.1);
  gcyl(33.2, 18.4, 0.05, 0.4, 0.48, 0xffffff);

  // Big plant at the north strip, umbrella stand and the inside doormat
  plant(X(37.5), Z(13.5), 0.25, 1.9, TEAL);
  gcyl(39.6, 19.4, 0.2, 0, 0.5, DARK);
  ([[39.52, 19.34, 0xef4444, 0.98], [39.66, 19.4, 0x3b82f6, 0.9], [39.55, 19.48, 0xf0c419, 0.86]] as const).forEach(([gx, gz, c, top]) => {
    gn(gx - 0.025, gx + 0.025, gz - 0.025, gz + 0.025, 0.5, top - 0.01, c);
    gn(gx - 0.05, gx + 0.05, gz - 0.05, gz + 0.05, top - 0.12, top, c);
  });
  gn(38.6, 39.8, 16.1, 17.9, 0, 0.012, 0x4a5568);
  gn(38.7, 39.7, 16.2, 17.8, 0.012, 0.016, 0x2f3340);
  gn(38.75, 38.85, 16.2, 17.8, 0.016, 0.02, 0xd9cfc0);
  gn(39.55, 39.65, 16.2, 17.8, 0.016, 0.02, 0xd9cfc0);

  // Entrance runner from the door and a standing screen totem (no text, just colour blocks)
  gn(34.7, 38.5, 16.25, 17.75, 0, 0.012, 0x8e2b3a);
  gn(34.8, 38.5, 16.32, 16.4, 0.012, 0.016, BRASS);
  gn(34.8, 38.5, 17.6, 17.68, 0.012, 0.016, BRASS);
  gb(35.7, 36.2, 13.25, 13.55, 0, 0.08, DARK);
  gb(35.9, 36.0, 13.35, 13.45, 0.08, 0.7, DARK);
  gb(35.62, 36.28, 13.3, 13.5, 0.7, 1.75, 0x2f3340);
  gn(35.68, 36.22, 13.5, 13.505, 0.78, 1.69, 0x2b4a6b);
  gn(35.74, 35.9, 13.505, 13.51, 0.85, 1.1, 0x38bdf8);
  gn(35.96, 36.12, 13.505, 13.51, 0.85, 1.3, 0x4ade80);
  gn(35.74, 36.12, 13.505, 13.51, 1.4, 1.6, 0xf0c419);

  kit.setPart("props-b:exterior");
  buildExterior();

  /** The lot around the slab: street with parked cars, sidewalks, bikes, benches, hedges, beds and trees. */
  function buildExterior(): void {
    const GY = -0.5;
    /** Flat ground cover from y GY − 0.02 up to `top`. */
    const flat = (x0: number, x1: number, z0: number, z1: number, c: number, top = -0.49) => nb(x0, x1, GY - 0.02, top, z0, z1, c);
    /** Paint on asphalt or paving (top at −0.48). */
    const paint = (x0: number, x1: number, z0: number, z1: number, c: number) => nb(x0, x1, -0.49, -0.48, z0, z1, c);

    const tree = (x: number, z: number, s = 1, c1 = 0x81b352, c2 = 0x93c45f) => {
      ob(x - 0.15 * s, x + 0.15 * s, GY, GY + 1.2 * s, z - 0.15 * s, z + 0.15 * s, 0x8a5a3c);
      blob(scene, x, GY + 1.95 * s, z, 1.0 * s, c1);
      blob(scene, x + 0.25 * s, GY + 2.55 * s, z + 0.2 * s, 0.6 * s, c2);
    };
    const conifer = (x: number, z: number, s = 1) => {
      ob(x - 0.13 * s, x + 0.13 * s, GY, GY + 0.7 * s, z - 0.13 * s, z + 0.13 * s, 0x6b4029);
      blob(scene, x, GY + 1.2 * s, z, 0.95 * s, 0x4a7c3a, 0.85);
      blob(scene, x, GY + 2.0 * s, z, 0.72 * s, 0x5a8f45, 0.9);
      blob(scene, x, GY + 2.7 * s, z, 0.45 * s, 0x6aa352, 1);
    };
    const bush = (x: number, z: number, r = 0.45, c = 0x669e3b) => blob(scene, x, GY + r * 0.65, z, r, c, 0.8);
    const flowers = [0xf6f0f6, 0xc58be0, 0xf48fb1, 0xf0c419, 0xef6a5b];

    /** Raised flower bed: stone border, foliage mass and scattered flowers. */
    const bed = (x0: number, x1: number, z0: number, z1: number, seed: number) => {
      ob(x0, x1, GY, GY + 0.12, z0, z1, STONE);
      nb(x0 + 0.08, x1 - 0.08, GY + 0.12, GY + 0.2, z0 + 0.08, z1 - 0.08, 0x4f8f35);
      const n = Math.max(4, Math.round(((x1 - x0) * (z1 - z0)) / 0.9));
      for (let i = 0; i < n; i++) {
        const fx = x0 + 0.2 + rnd(seed + i * 2) * (x1 - x0 - 0.4);
        const fz = z0 + 0.2 + rnd(seed + i * 2 + 1) * (z1 - z0 - 0.4);
        const h = 0.08 + rnd(seed + i) * 0.1;
        nb(fx - 0.07, fx + 0.07, GY + 0.2, GY + 0.2 + h + 0.1, fz - 0.07, fz + 0.07, flowers[(i + seed) % flowers.length]!);
      }
    };

    const hedge = (x0: number, x1: number, z0: number, z1: number, h = 0.8) => {
      ob(x0, x1, GY, GY + h, z0, z1, 0x5a9a35);
      nb(x0 + 0.05, x1 - 0.05, GY + h, GY + h + 0.08, z0 + 0.05, z1 - 0.05, 0x74ae45);
    };

    const bench = (x: number, z: number, rotY: number) => {
      const g = place(x, GY + 0.01, z, rotY);
      ob(-0.75, 0.75, 0.4, 0.46, -0.22, 0.2, 0xb9774a, g);
      ob(-0.75, 0.75, 0.52, 0.92, -0.26, -0.2, 0xa8693f, g);
      for (const sx of [-0.62, 0.62]) ob(sx - 0.05, sx + 0.05, 0, 0.4, -0.2, 0.18, DARK, g);
    };

    const lamp = (x: number, z: number, h = 2.5) => {
      ob(x - 0.15, x + 0.15, GY, GY + 0.3, z - 0.15, z + 0.15, DARK);
      ob(x - 0.07, x + 0.07, GY + 0.3, GY + h, z - 0.07, z + 0.07, DARK);
      ob(x - 0.22, x + 0.22, GY + h, GY + h + 0.22, z - 0.22, z + 0.22, 0xf9e79f);
    };

    /** Parked car; local +z is the front, `heading` turns it about Y. */
    const car = (x: number, z: number, heading: number, kind: "sedan" | "hatch" | "van", body: number, stripe?: number) => {
      const g = place(x, GY + 0.01, z, heading);
      g.userData.boxCar = true; // hidden once the GLB cars are loaded (office-cars.ts)
      const GLASS = 0x8ec9e0;
      const L = kind === "van" ? 2.1 : kind === "hatch" ? 1.75 : 1.9;
      const W = kind === "van" ? 0.9 : 0.85;
      for (const sx of [-1, 1]) {
        for (const wz of [-L + 0.65, L - 0.65]) {
          ob(sx > 0 ? W - 0.14 : -W - 0.04, sx > 0 ? W + 0.04 : -W + 0.14, 0, 0.58, wz - 0.3, wz + 0.3, 0x282a36, g);
        }
      }
      if (kind === "van") {
        ob(-W, W, 0.25, 1.75, -L, 0.95, body, g);
        ob(-W, W, 0.25, 0.85, 0.95, L, body, g);
        nb(-W + 0.1, W - 0.1, 0.95, 1.5, 0.95, 0.99, GLASS, g);
        nb(W, W + 0.02, 1.0, 1.5, 0.15, 0.9, GLASS, g);
        nb(-W - 0.02, -W, 1.0, 1.5, 0.15, 0.9, GLASS, g);
        if (stripe !== undefined) {
          nb(W, W + 0.015, 0.55, 0.8, -L, 0.95, stripe, g);
          nb(-W - 0.015, -W, 0.55, 0.8, -L, 0.95, stripe, g);
        }
        nb(-W + 0.1, W - 0.1, 1.75, 1.78, -L + 0.1, 0.9, 0xe3e8ec, g);
      } else {
        ob(-W, W, 0.25, 0.78, -L, L, body, g);
        const cabBack = kind === "hatch" ? -L + 0.2 : -1.0;
        ob(-0.7, 0.7, 0.78, 1.25, cabBack, 0.95, GLASS, g);
        ob(-0.74, 0.74, 1.25, 1.32, cabBack - 0.05, 1.0, body, g);
      }
      // Bumpers, lights, plate
      ob(-W + 0.03, W - 0.03, 0.28, 0.45, L, L + 0.07, DARK, g);
      for (const sx of [-1, 1]) {
        nb(sx * 0.48 - 0.15, sx * 0.48 + 0.15, 0.5, 0.64, L, L + 0.02, 0xfff3b0, g);
        nb(sx * 0.48 - 0.15, sx * 0.48 + 0.15, 0.5, 0.64, -L - 0.02, -L, 0xef4444, g);
      }
    };

    const bike = (x: number, z: number, rotY: number, frame: number) => {
      const g = place(x, GY + 0.01, z, rotY);
      for (const wz of [-0.5, 0.5]) {
        const geom = new THREE.TorusGeometry(0.3, 0.04, 5, 14);
        disposables.push(geom);
        const wheel = new THREE.Mesh(geom, material(0x282a36));
        wheel.name = "props-b";
        wheel.rotation.y = Math.PI / 2;
        wheel.position.set(0, 0.32, wz);
        g.add(wheel);
      }
      nb(-0.02, 0.02, 0.3, 0.36, -0.5, 0.1, frame, g);
      nb(-0.028, 0.028, 0.3, 0.8, -0.2, -0.14, frame, g);
      nb(-0.024, 0.024, 0.62, 0.68, -0.2, 0.5, frame, g);
      nb(-0.032, 0.032, 0.32, 0.88, 0.46, 0.52, frame, g);
      nb(-0.2, 0.2, 0.86, 0.9, 0.44, 0.52, DARK, g);
      nb(-0.06, 0.06, 0.8, 0.85, -0.34, -0.06, DARK, g);
    };

    // ---- Sidewalk detail: joints, edging stone ----
    for (let x = -24; x <= 21; x += 3.6) nb(x - 0.02, x + 0.02, -0.495, -0.485, 11, 13, JOINT);
    nb(-30, 24, -0.495, -0.483, 11.97, 12.03, JOINT);
    for (let x = 23; x <= 30; x += 3.6) nb(x - 0.02, x + 0.02, -0.495, -0.485, 5.5, 8.5, JOINT);
    ob(-50, 30, GY, GY + 0.06, 13.0, 13.12, STONE);

    // ---- Street: curb, asphalt, parking bays, lane markings, zebra, far sidewalk ----
    ob(-50, 30, GY, -0.42, 14.45, 14.6, STONE);
    flat(-50, 30, 14.6, 24.5, ASPHALT);
    for (let x = -16.8; x <= 9.4; x += 2.8) paint(x - 0.05, x + 0.05, 14.8, 19.15, 0xf0efe8);
    paint(-16.85, 9.45, 19.15, 19.25, 0xf0efe8);
    for (let x = -34; x < 22; x += 3) if (x + 1.5 < 12.4 || x > 15.6) paint(x, x + 1.5, 21.85, 21.95, 0xf0c419);
    for (let z = 14.9; z < 24.2; z += 1) paint(12.5, 15.5, z, z + 0.5, 0xf0efe8);
    ob(-50, 30, GY, -0.42, 24.5, 24.65, STONE);
    flat(-50, 30, 24.65, 26.8, PAVING);
    hedge(-30, 12, 27.1, 27.8, 0.8);
    tree(-6, 29.8, 1.1);
    tree(-14, 29.5, 0.9, 0x6fa844, 0x84bd52);

    car(-12.8, 16.9, Math.PI, "sedan", 0xc3262e);
    car(-7.2, 16.9, Math.PI, "hatch", 0x3b6fb6);
    car(-1.6, 16.9, Math.PI, "van", 0xeef1f3, 0x3b6fb6);
    car(4.0, 16.9, Math.PI, "sedan", 0x7b8794);

    // ---- Sidewalk furniture ----
    lamp(-17, 12.6);
    lamp(7.5, 12.6);
    lamp(18.5, 12.6);
    bench(-1.5, 12.0, 0);
    bench(4.2, 12.0, 0);
    // Bike rack with three bikes (rack rail along x, bikes along z)
    nb(-10.4, -7.6, GY + 0.5, GY + 0.56, 11.55, 11.62, STEEL);
    for (const x of [-10.4, -9.0, -7.6]) nb(x - 0.03, x + 0.03, GY, GY + 0.5, 11.55, 11.62, STEEL);
    bike(-9.8, 12.2, 0, 0xc3262e);
    bike(-9.0, 12.2, 0, 0x3b82f6);
    bike(-8.2, 12.2, 0, 0x4ade80);
    // Mailbox, hydrant, bin, bus stop sign
    ob(10.0, 10.6, GY, GY + 0.5, 12.2, 12.5, 0x3b6fb6);
    ob(9.9, 10.7, GY + 0.5, GY + 1.0, 12.1, 12.6, 0x3b6fb6);
    ob(9.95, 10.65, GY + 1.0, GY + 1.08, 12.15, 12.55, 0x2a4f87);
    nb(10.1, 10.5, GY + 0.62, GY + 0.7, 12.6, 12.61, 0xf8fafc);
    cyl(8.3, 12.3, 0.17, GY, GY + 0.55, 0xef4444);
    cyl(8.3, 12.3, 0.22, GY + 0.55, GY + 0.6, 0xc3262e);
    cyl(1.4, 12.4, 0.25, GY, GY + 0.7, 0x4b5563);
    cyl(1.4, 12.4, 0.28, GY + 0.7, GY + 0.76, DARK);
    ob(14.9, 15.05, GY, GY + 2.3, 11.7, 11.85, DARK);
    ob(14.6, 15.35, GY + 1.95, GY + 2.5, 11.67, 11.88, 0x3b6fb6);
    nb(14.7, 15.25, GY + 2.05, GY + 2.4, 11.88, 11.89, 0xf0c419);

    // ---- Verge between sidewalk and street: trees, hedges, beds, bushes ----
    hedge(-34, -20, 13.3, 14.0, 0.7);
    bed(-8.5, -3, 13.4, 14.2, 3);
    bed(12.5, 17.5, 13.4, 14.2, 11);
    tree(3, 13.8, 0.75, 0xf2a6c0, 0xf7c0d4);
    tree(-24, 13.8, 1.1);
    tree(-18.5, 13.8, 0.8, 0xe0a040, 0xeab75a);
    bush(-15, 13.7, 0.45);
    bush(6.5, 13.8, 0.4, 0x5e9a3a);
    bush(-1, 13.7, 0.35, 0x7fb74a);

    // ---- East: parking with a tree island, bench and lamp by the path ----
    ob(21.5, 21.7, GY, -0.42, -10, 4.4, STONE);
    ob(21.7, 34, GY, -0.42, 4.2, 4.4, STONE);
    flat(21.7, 34, -10, 4.2, ASPHALT);
    for (const z of [-2.5, 0.5, 3.5]) paint(22.2, 28, z - 0.05, z + 0.05, 0xf0efe8);
    ob(22.7, 25.3, GY, -0.38, -5.3, -2.7, STONE);
    nb(22.8, 25.2, -0.38, -0.37, -5.2, -2.8, GRASS);
    bush(23.2, -4.6, 0.3, 0x5e9a3a);
    bush(24.9, -3.2, 0.28, 0x7fb74a);
    car(25.2, -1.0, -Math.PI / 2, "sedan", 0xe8b923);
    car(25.2, 2.0, -Math.PI / 2, "hatch", 0x3e898e);
    bench(24.5, 4.95, 0);
    lamp(28.2, 4.95);
    ob(22.2, 22.6, GY, GY + 0.5, 9.0, 9.3, 0x3b6fb6);
    ob(22.1, 22.7, GY + 0.5, GY + 0.95, 8.95, 9.35, 0x3b6fb6);

    // ---- North: beds, path, hedge, trees ----
    flat(-50, 50, -23.4, -21.6, PAVING);
    bed(-14, -6, -20.4, -19.2, 21);
    hedge(-40, 20, -25.2, -24.4, 0.9);
    lamp(-10, -21.0);
    tree(-14, -27, 1.2);
    tree(-5, -28, 1.0, 0x6fa844, 0x84bd52);
    conifer(2, -27.5, 1.2);
    tree(8, -26.8, 1.1, 0xe0a040, 0xeab75a);
    conifer(15, -29, 1.4);
    tree(-22, -22, 1.0);
    bush(-17, -23.5, 0.5);
    bush(5, -23.6, 0.45, 0x7fb74a);
    bush(-4, -20.2, 0.4);
    bush(12, -19.5, 0.4, 0x5e9a3a);
    for (const [bx, bz, br] of [[-9, -19.1, 0.45], [-12, -20.5, 0.55], [1, -19.4, 0.5], [8, -20.2, 0.6], [14, -21, 0.5], [-1.5, -21.1, 0.4]] as const) bush(bx, bz, br, bx % 2 ? 0x669e3b : 0x5e9a3a);

    // ---- West: picnic table, beds, hedge, fence, trees ----
    {
      const g = place(-29, GY + 0.01, -7, 0);
      ob(-0.9, 0.9, 0.7, 0.78, -0.4, 0.4, 0xb9774a, g);
      for (const sx of [-0.7, 0.7]) ob(sx - 0.06, sx + 0.06, 0, 0.7, -0.35, 0.35, DARK, g);
      ob(-0.9, 0.9, 0.38, 0.44, -0.78, -0.5, 0xa8693f, g);
      ob(-0.9, 0.9, 0.38, 0.44, 0.5, 0.78, 0xa8693f, g);
      for (const sx of [-0.7, 0.7]) {
        ob(sx - 0.05, sx + 0.05, 0, 0.38, -0.75, -0.55, DARK, g);
        ob(sx - 0.05, sx + 0.05, 0, 0.38, 0.55, 0.75, DARK, g);
      }
      nb(-0.2, 0.2, 0.78, 0.8, -0.2, 0.2, 0xef4444, g);
    }
    bed(-32, -29, -12, -10.4, 41);
    hedge(-36, -33.5, -22, -2, 0.8);
    tree(-28, -16, 1.2);
    conifer(-24.5, -18, 1.1);
    tree(-31, -3, 1.0, 0xf2a6c0, 0xf7c0d4);
    bush(-26, -9.5, 0.45);
    bush(-26.5, -2, 0.4, 0x7fb74a);
    bush(-22.5, 0.5, 0.4, 0x5e9a3a);
  }
}
