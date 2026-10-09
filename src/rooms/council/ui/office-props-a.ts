import type { PropsKit } from "./office-props-kit";

// Part A of the set dressing: meeting room, open space, corridor and the wall decor of the two back walls.
// Everything is authored in grid units (x = gx − 20, z = gz − 10); the north wall face is gz 0, the west wall face gx 0.
// Floor-standing props are listed in office-blockers-a.ts.

const BOOK_COLORS = [0xc3182a, 0x3b82f6, 0x64a83b, 0xf0c419, 0xf48fb1, 0x3e898e, 0xcb614b, 0x6d28d9];
const DARK = 0x3a3d4a;
const PAPER = 0xf8fafc;
const CREAM = 0xf4ead2;
const LEAF = 0x669e3b;
const LEAF_DARK = 0x518530;
const TERRACOTTA = 0xce6b4e;
const TEAL = 0x3e898e;
const SILVER = 0xc9ced6;

type Wall = "n" | "w" | "c";
type Opts = { outline?: boolean; opacity?: number };

type DeskCfg = {
  gx: number;
  gz: number;
  lb: "monitor" | "laptop" | "plant" | "books" | "frame" | "none";
  lf: "papers" | "phones" | "books" | "none";
  rb: "plant" | "cactus" | "duck" | "frame" | "figurine";
  mug: number;
  notepad: boolean;
  shade: number;
  cone: boolean;
  ped: "L" | "R";
  notes: Array<[number, number, number]>; // colour, u, y on the main monitor
};

const DESKS: DeskCfg[] = [
  { gx: 14, gz: 3, lb: "monitor", lf: "none", rb: "plant", mug: 0xef4444, notepad: false, shade: 0xf0d27a, cone: false, ped: "R", notes: [[0xfef08a, 1.12, 1.06], [0xf48fb1, 0.78, 1.09]] },
  { gx: 16, gz: 3, lb: "laptop", lf: "none", rb: "cactus", mug: 0x3b82f6, notepad: false, shade: 0x6fa8b0, cone: true, ped: "L", notes: [[0x81d4fa, 1.1, 1.05]] },
  { gx: 14, gz: 4, lb: "monitor", lf: "phones", rb: "duck", mug: 0x4ade80, notepad: true, shade: 0xef6f6c, cone: false, ped: "L", notes: [[0xfef08a, 1.12, 1.06], [0x81d4fa, 0.78, 1.09], [0xf48fb1, 0.96, 1.0]] },
  { gx: 16, gz: 4, lb: "laptop", lf: "papers", rb: "plant", mug: 0xffffff, notepad: false, shade: 0xf0d27a, cone: true, ped: "R", notes: [[0xa5d6a7, 1.12, 1.08]] },
  { gx: 20, gz: 3, lb: "plant", lf: "none", rb: "figurine", mug: 0xcb614b, notepad: false, shade: 0xf0d27a, cone: true, ped: "L", notes: [[0xfef08a, 1.1, 1.06], [0xf48fb1, 0.8, 1.1]] },
  { gx: 22, gz: 3, lb: "monitor", lf: "none", rb: "cactus", mug: TEAL, notepad: false, shade: 0xef6f6c, cone: false, ped: "R", notes: [[0x81d4fa, 1.12, 1.06], [0xfef08a, 0.8, 1.08]] },
  { gx: 20, gz: 4, lb: "laptop", lf: "phones", rb: "frame", mug: 0xf0c419, notepad: true, shade: 0x6fa8b0, cone: false, ped: "R", notes: [] },
  { gx: 22, gz: 4, lb: "monitor", lf: "papers", rb: "plant", mug: 0xef4444, notepad: true, shade: 0xf0d27a, cone: true, ped: "L", notes: [[0xf48fb1, 1.12, 1.07], [0xa5d6a7, 0.8, 1.1]] },
];

/** Extra props, part A (see office-blockers-a.ts for the ones that stand on the floor). */
export function buildPropsA(kit: PropsKit): void {
  const { THREE, scene, box, gridBox, blob, material, disposables, OUTLINE } = kit;
  let part = "props-a";
  const P = (name: string) => {
    part = `props-a:${name}`;
    kit.setPart(part);
  };

  /** Grid box; tiny pieces go without an outline so they do not turn into dark blobs at half resolution. */
  const g = (gx0: number, gx1: number, gz0: number, gz1: number, y0: number, y1: number, color: number, o?: Opts) =>
    gridBox(scene, gx0, gx1, gz0, gz1, y0, y1, color, {
      ...o,
      outline: o?.outline ?? Math.max(gx1 - gx0, y1 - y0, gz1 - gz0) >= 0.2,
    });

  const disc = (x: number, y: number, z: number, r: number, t: number, color: number, axis: "x" | "z", segs = 16) => {
    const geom = new THREE.CylinderGeometry(r, r, t, segs);
    if (axis === "z") geom.rotateX(Math.PI / 2);
    else geom.rotateZ(Math.PI / 2);
    disposables.push(geom);
    const mesh = new THREE.Mesh(geom, material(color));
    mesh.name = part;
    mesh.position.set(x, y, z);
    scene.add(mesh);
    return mesh;
  };

  /** Box on a wall plane: u runs along the wall (gx on the north/corridor walls, gz on the west wall), d is the depth off the wall. */
  const wb = (w: Wall, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, color: number, o?: Opts) => {
    const base = w === "c" ? 0.015 : 0.005;
    if (w === "n") return g(u0, u1, base + d0, base + d1, y0, y1, color, o);
    if (w === "w") return g(base + d0, base + d1, u0, u1, y0, y1, color, o);
    return g(u0, u1, 11.15 + base + d0, 11.15 + base + d1, y0, y1, color, o);
  };

  const wdisc = (w: Wall, u: number, y: number, r: number, d0: number, d1: number, color: number) => {
    const base = w === "c" ? 0.015 : 0.005;
    const c = base + (d0 + d1) / 2;
    const t = d1 - d0;
    if (w === "n") return disc(u - 20, y, c - 10, r, t, color, "z");
    if (w === "w") return disc(c - 20, y, u - 10, r, t, color, "x");
    return disc(u - 20, y, 1.15 + c, r, t, color, "z");
  };

  /** Framed abstract picture. */
  const pic = (w: Wall, u0: number, u1: number, y0: number, y1: number, kind: string, frame: number) => {
    const f = Math.min(0.07, (u1 - u0) * 0.12);
    wb(w, u0, u1, y0, y1, 0, 0.05, frame);
    wb(w, u0 + f, u1 - f, y0 + f, y1 - f, 0.05, 0.056, 0xf4f0e4, { outline: false });
    const a = f + 0.04;
    const iu0 = u0 + a, iu1 = u1 - a, iy0 = y0 + a, iy1 = y1 - a;
    const U = (t: number) => iu0 + t * (iu1 - iu0);
    const V = (t: number) => iy0 + t * (iy1 - iy0);
    const R = (ta: number, tb: number, va: number, vb: number, color: number, k = 0) =>
      wb(w, U(ta), U(tb), V(va), V(vb), 0.056 + k * 0.004, 0.06 + k * 0.004, color, { outline: false });
    const W = (iu1 - iu0);
    switch (kind) {
      case "sunset":
        R(0, 1, 0.3, 1, 0xf0c070);
        R(0, 1, 0.7, 1, 0xf7d99a, 1);
        wdisc(w, U(0.65), V(0.6), Math.min(W, iy1 - iy0) * 0.17, 0.064, 0.068, 0xfff0a8);
        R(0, 1, 0, 0.35, LEAF, 2);
        R(0, 0.5, 0.3, 0.45, 0x81b352, 3);
        break;
      case "geo":
        R(0, 1, 0, 1, 0xf4ead2);
        R(0.06, 0.55, 0.08, 0.6, TEAL, 1);
        R(0.45, 0.94, 0.4, 0.92, 0xcb614b, 2);
        wdisc(w, U(0.3), V(0.78), Math.min(W, iy1 - iy0) * 0.16, 0.068, 0.072, 0xf0c419);
        R(0.1, 0.9, 0.02, 0.06, DARK, 3);
        break;
      case "chart":
        R(0, 1, 0, 1, 0x2b4a6b);
        R(0.1, 0.25, 0.08, 0.4, 0x38bdf8, 1);
        R(0.3, 0.45, 0.08, 0.6, 0x4ade80, 1);
        R(0.5, 0.65, 0.08, 0.5, 0x38bdf8, 1);
        R(0.7, 0.85, 0.08, 0.82, 0x4ade80, 1);
        break;
      case "mountain":
        R(0, 1, 0, 1, 0xbfe9ff);
        R(0.1, 0.9, 0.1, 0.35, 0x64748b, 1);
        R(0.22, 0.78, 0.35, 0.58, 0x64748b, 1);
        R(0.36, 0.64, 0.58, 0.78, 0xf8fafc, 1);
        R(0, 1, 0, 0.14, LEAF, 2);
        break;
      case "stripes":
        [0xcb614b, 0xf0c419, 0x4ade80, 0x38bdf8, 0x8b5cf6].forEach((c, i) => R(i * 0.2, i * 0.2 + 0.2, 0, 1, c));
        break;
      case "plant":
        R(0, 1, 0, 1, 0xe6f2e8);
        R(0.32, 0.68, 0.02, 0.28, TERRACOTTA, 1);
        R(0.46, 0.54, 0.28, 0.85, LEAF, 1);
        R(0.2, 0.46, 0.4, 0.58, LEAF_DARK, 2);
        R(0.54, 0.8, 0.5, 0.68, LEAF, 2);
        break;
      case "map":
        R(0, 1, 0, 1, 0xc9e7f2);
        R(0.1, 0.45, 0.4, 0.85, 0xa5d6a7, 1);
        R(0.5, 0.9, 0.1, 0.6, 0xe6cfaf, 1);
        R(0.2, 0.35, 0.1, 0.35, 0xf0c070, 1);
        break;
      default:
        break;
    }
  };

  /** Round clock on a wall: dark rim, white face, two hands. */
  const clock = (w: Wall, u: number, y: number, r: number) => {
    wdisc(w, u, y, r + 0.04, 0, 0.06, DARK);
    wdisc(w, u, y, r, 0.06, 0.08, PAPER);
    const base = w === "c" ? 0.015 : 0.005;
    const hand = (len: number, deg: number, width: number) => {
      const th = (deg * Math.PI) / 180;
      const cu = u + (Math.sin(th) * len) / 2;
      const cy = y + (Math.cos(th) * len) / 2;
      const d0 = base + 0.08, d1 = base + 0.092;
      const m = wb(w, cu - width / 2, cu + width / 2, cy - len / 2, cy + len / 2, d0 - base, d1 - base, DARK, { outline: false });
      if (w === "w") m.rotation.x = th;
      else m.rotation.z = -th;
    };
    hand(r * 0.62, 300, 0.035);
    hand(r * 0.85, 60, 0.028);
    [0, 90, 180, 270].forEach((deg) => {
      const th = (deg * Math.PI) / 180;
      wb(w, u + Math.sin(th) * r * 0.86 - 0.02, u + Math.sin(th) * r * 0.86 + 0.02, y + Math.cos(th) * r * 0.86 - 0.02, y + Math.cos(th) * r * 0.86 + 0.02, 0.08, 0.088, DARK, { outline: false });
    });
  };

  /** Row of books standing on a shelf at (gx0..gx1, gz0..gz1), shelf top y. */
  const bookRow = (gx0: number, gx1: number, gz0: number, gz1: number, y: number, count: number, seed: number, maxH = 0.38, alongX = true) => {
    const span = alongX ? gx1 - gx0 : gz1 - gz0;
    let at = 0;
    for (let i = 0; i < count && at < span - 0.05; i++) {
      const w = 0.06 + (((i + seed) * 7) % 3) * 0.02;
      const h = maxH - (((i * 5 + seed) % 4) * 0.05);
      const c = BOOK_COLORS[(i + seed) % BOOK_COLORS.length]!;
      if (alongX) g(gx0 + at, gx0 + at + w, gz0, gz1, y, y + h, c, { outline: false });
      else g(gx0, gx1, gz0 + at, gz0 + at + w, y, y + h, c, { outline: false });
      at += w + 0.005;
    }
  };

  /** Small pot plant standing at grid (gx, gz) on a surface at height y. */
  const miniPlant = (gx: number, gz: number, y: number, size = 0.08, seed = 0) => {
    g(gx - size, gx + size, gz - size, gz + size, y, y + size * 1.5, seed % 2 ? TEAL : TERRACOTTA);
    blob(scene, gx - 20, y + size * 1.5 + size * 1.2, gz - 10, size * 1.55, seed % 2 ? LEAF : LEAF_DARK, 1.1);
  };

  /** Tall potted plant (blobs on a trunk) standing on the floor at grid (gx, gz). */
  const bigPlant = (gx: number, gz: number, seed: number, tall = 1.0) => {
    const pot = seed % 2 ? TEAL : TERRACOTTA;
    g(gx - 0.25, gx + 0.25, gz - 0.25, gz + 0.25, 0, 0.42, pot);
    g(gx - 0.21, gx + 0.21, gz - 0.21, gz + 0.21, 0.42, 0.44, 0x5a3d2b, { outline: false });
    g(gx - 0.04, gx + 0.04, gz - 0.04, gz + 0.04, 0.44, 0.44 + 0.7 * tall, 0x8a5a3c, { outline: false });
    const x = gx - 20, z = gz - 10;
    blob(scene, x, 0.44 + 0.8 * tall, z, 0.42, LEAF, 1.15);
    blob(scene, x + 0.17, 0.44 + 1.2 * tall, z + 0.08, 0.3, LEAF_DARK, 1.15);
    blob(scene, x - 0.15, 0.44 + 1.15 * tall, z - 0.08, 0.28, LEAF, 1.15);
    blob(scene, x + 0.02, 0.44 + 1.45 * tall, z, 0.22, 0x81b352, 1.15);
  };

  /** Floor rug: border, field. */
  const rug = (gx0: number, gx1: number, gz0: number, gz1: number, border: number, field: number, inset = 0.14, stripe?: number) => {
    g(gx0, gx1, gz0, gz1, 0.006, 0.012, border, { outline: false });
    g(gx0 + inset, gx1 - inset, gz0 + inset, gz1 - inset, 0.012, 0.016, field, { outline: false });
    if (stripe !== undefined) {
      g(gx0 + inset * 1.8, gx1 - inset * 1.8, gz0 + inset * 1.8, gz1 - inset * 1.8, 0.016, 0.019, stripe, { outline: false });
      g(gx0 + inset * 2.4, gx1 - inset * 2.4, gz0 + inset * 2.4, gz1 - inset * 2.4, 0.019, 0.022, field, { outline: false });
    }
  };

  // ======================================================================
  // MEETING ROOM (gx 0–12, gz 0–11)
  // ======================================================================
  P("meeting-rug");
  rug(1.5, 10.5, 2.2, 7.8, 0xd9a05b, 0xf2d8a7, 0.16, 0xc9703e);

  P("meeting-table");
  const TOP = 0.965;
  // Conference phone in the middle of the table, cable hanging off the south edge
  g(6.2, 6.62, 4.84, 5.16, TOP, TOP + 0.05, 0x2b2f3a);
  g(6.26, 6.36, 4.88, 4.98, TOP + 0.05, TOP + 0.057, 0x4b5262, { outline: false });
  g(6.46, 6.56, 4.88, 4.98, TOP + 0.05, TOP + 0.057, 0x4b5262, { outline: false });
  g(6.36, 6.46, 5.05, 5.12, TOP + 0.05, TOP + 0.057, 0x4ade80, { outline: false });
  g(6.38, 6.44, 5.16, 5.93, TOP, TOP + 0.014, 0x282a36, { outline: false });
  g(6.38, 6.44, 5.935, 5.985, 0.58, TOP + 0.014, 0x282a36, { outline: false });
  g(6.35, 6.47, 5.92, 6.0, 0.52, 0.6, 0x282a36, { outline: false });
  // Projector pointing at the wall screen
  g(8.15, 8.75, 4.86, 5.2, TOP, TOP + 0.15, 0xe8eef0);
  g(8.38, 8.52, 4.82, 4.86, TOP + 0.05, TOP + 0.11, 0x2b2f3a, { outline: false });
  g(8.6, 8.7, 5.0, 5.1, TOP + 0.15, TOP + 0.157, 0x4ade80, { outline: false });
  // Water: two bottles, glasses around them
  for (const [gx, gz] of [[4.3, 4.95], [7.05, 4.95]] as const) {
    g(gx - 0.07, gx + 0.07, gz - 0.07, gz + 0.07, TOP, TOP + 0.28, 0x7fd6ee, { opacity: 0.8, outline: false });
    g(gx - 0.035, gx + 0.035, gz - 0.035, gz + 0.035, TOP + 0.28, TOP + 0.35, 0x2b7fb0, { outline: false });
  }
  for (const [gx, gz] of [[4.65, 4.9], [4.05, 5.15], [7.4, 4.9], [6.85, 5.2], [3.6, 5.45], [8.8, 5.55]] as const) {
    g(gx - 0.05, gx + 0.05, gz - 0.05, gz + 0.05, TOP, TOP + 0.12, 0xbfe9ff, { opacity: 0.75, outline: false });
  }
  // Fruit bowl and a cookie plate
  g(9.3, 9.65, 4.85, 5.2, TOP, TOP + 0.07, PAPER);
  blob(scene, 9.4 - 20, TOP + 0.12, 5.0 - 10, 0.07, 0xf08c1e);
  blob(scene, 9.55 - 20, TOP + 0.12, 5.1 - 10, 0.07, 0x93c45f);
  blob(scene, 9.48 - 20, TOP + 0.16, 5.02 - 10, 0.06, 0xe11d48);
  g(3.9, 4.35, 5.3, 5.7, TOP, TOP + 0.03, PAPER);
  for (const [gx, gz] of [[4.1, 5.5]] as const) g(gx - 0.05, gx + 0.05, gz - 0.05, gz + 0.05, TOP + 0.03, TOP + 0.07, 0xb5651d, { outline: false });
  // Notebooks and pens at the seats (the spots where the old laptops, papers and mug lie stay free)
  const notebookColors = [TEAL, 0xcb614b, 0x3b82f6, 0xf0c419, 0x64748b, 0xe11d48, 0x8b5cf6];
  const notebooks: Array<[number, number, number]> = [
    [2.2, 4.75, 1], [4.8, 4.15, 0], [6.8, 4.15, 0], [9.15, 4.12, 0], [2.8, 5.45, 0], [4.8, 5.45, 0], [8.4, 5.5, 0],
  ];
  notebooks.forEach(([gx, gz, rot], i) => {
    const w = rot ? 0.34 : 0.4, h = rot ? 0.42 : 0.32;
    g(gx, gx + w, gz, gz + h, TOP, TOP + 0.035, notebookColors[i % notebookColors.length]!);
    g(gx + w + 0.04, gx + w + 0.2, gz + 0.05, gz + 0.08, TOP, TOP + 0.03, i % 2 ? 0x3b82f6 : 0xe11d48, { outline: false });
  });
  // Tissue box and a small plant at the east end
  g(2.3, 2.6, 5.45, 5.7, TOP, TOP + 0.1, 0x93c4e8);
  miniPlant(9.7, 5.6, TOP, 0.09, 0);

  P("meeting-credenza");
  // Credenza under the whiteboard (west wall, gz 7.3–9.9), with a coffee corner on top
  g(0.005, 0.55, 7.3, 9.9, 0, 0.8, 0xa8693f);
  g(0.005, 0.58, 7.3, 9.9, 0.8, 0.86, 0xc98a4a);
  for (let i = 0; i < 3; i++) {
    const z0 = 7.38 + i * 0.84;
    g(0.55, 0.575, z0, z0 + 0.76, 0.1, 0.72, 0xb97a4c, { outline: false });
  }
  g(0.06, 0.34, 8.55, 8.95, 0.86, 1.2, 0x3d363e); // coffee machine
  g(0.34, 0.37, 8.65, 8.85, 0.98, 1.1, 0xd4a537, { outline: false });
  g(0.28, 0.4, 8.62, 8.74, 0.86, 0.96, 0xffffff, { outline: false });
  g(0.12, 0.26, 7.5, 7.64, 0.86, 1.14, SILVER); // thermos
  g(0.13, 0.25, 7.51, 7.63, 1.14, 1.2, 0xcb614b, { outline: false });
  g(0.12, 0.26, 7.72, 7.86, 0.86, 1.1, 0xe11d48);
  for (let i = 0; i < 2; i++) g(0.34, 0.44, 8.05 + i * 0.12, 8.15 + i * 0.12, 0.86, 0.96, PAPER, { outline: false }); // cups
  g(0.16, 0.5, 9.1, 9.5, 0.86, 0.9, 0x6b4029, { outline: false }); // tray
  g(0.22, 0.34, 9.18, 9.3, 0.9, 1.0, 0xffffff, { outline: false });
  g(0.36, 0.46, 9.3, 9.4, 0.9, 0.98, 0xf0c070, { outline: false });
  miniPlant(0.3, 9.7, 0.86, 0.1, 1);

  P("meeting-north");
  // Sideboard along the north wall, a water cooler next to it and a tall plant in the north-east corner
  g(1.35, 3.1, 0.05, 0.5, 0, 0.8, 0xa8693f);
  g(1.33, 3.12, 0.04, 0.52, 0.8, 0.85, 0xc98a4a);
  [1.4, 2.0, 2.58].forEach((x) => {
    g(x, x + 0.5, 0.5, 0.515, 0.1, 0.72, 0xb97a4c, { outline: false });
  });
  g(1.5, 1.85, 0.15, 0.4, 0.85, 0.89, CREAM, { outline: false });
  g(1.52, 1.9, 0.17, 0.42, 0.89, 0.93, 0xf8fafc, { outline: false });
  bookRow(2.0, 2.45, 0.1, 0.3, 0.85, 4, 2, 0.26);
  g(2.7, 2.78, 0.2, 0.28, 0.85, 1.05, DARK, { outline: false }); // table lamp
  g(2.6, 2.88, 0.12, 0.36, 1.05, 1.2, 0xf3e3b5);
  g(3.3, 3.75, 0.1, 0.55, 0, 0.95, 0xeef2f4); // water cooler
  g(3.3, 3.75, 0.1, 0.55, 0.95, 1.0, 0xcfd8dd);
  g(3.4, 3.65, 0.2, 0.45, 1.0, 1.4, 0x4dbfe1, { opacity: 0.85 });
  g(3.45, 3.6, 0.55, 0.6, 0.55, 0.65, 0x3b82f6, { outline: false });
  g(3.45, 3.6, 0.55, 0.6, 0.7, 0.8, 0xef4444, { outline: false });
  bigPlant(11.35, 0.7, 1);

  P("meeting-coatrack");
  g(0.4, 0.8, 10.15, 10.55, 0, 0.05, 0x8a5a3c);
  g(0.57, 0.63, 10.32, 10.38, 0.05, 1.75, 0x8a5a3c);
  g(0.4, 0.8, 10.31, 10.39, 1.7, 1.76, 0x8a5a3c);
  g(0.36, 0.56, 10.17, 10.5, 0.9, 1.65, 0x3e5c8a); // coat
  g(0.64, 0.82, 10.22, 10.5, 1.0, 1.55, 0xb5651d);
  g(0.66, 0.78, 10.45, 10.55, 0.1, 0.4, 0x6b7280); // umbrella
  g(0.7, 0.75, 10.46, 10.5, 0.4, 0.9, 0x6b7280, { outline: false });

  P("meeting-flipchart");
  g(9.58, 9.66, 0.52, 0.6, 0, 0.9, 0xb8bcc4);
  g(10.54, 10.62, 0.52, 0.6, 0, 0.9, 0xb8bcc4);
  g(10.05, 10.13, 0.9, 0.98, 0, 1.25, 0xb8bcc4);
  g(9.5, 10.7, 0.5, 0.66, 0.84, 0.9, 0x8a5a3c); // tray
  g(9.52, 10.68, 0.52, 0.6, 0.9, 2.0, 0xe8eef0);
  g(9.58, 10.62, 0.6, 0.63, 0.96, 1.94, PAPER, { outline: false });
  g(9.8, 10.4, 0.6, 0.64, 1.9, 1.98, 0xb8bcc4, { outline: false });
  g(9.7, 9.85, 0.63, 0.65, 1.0, 1.35, 0x38bdf8, { outline: false });
  g(9.9, 10.05, 0.63, 0.65, 1.0, 1.6, 0x4ade80, { outline: false });
  g(10.1, 10.25, 0.63, 0.65, 1.0, 1.15, 0xf0c419, { outline: false });
  g(10.3, 10.45, 0.63, 0.65, 1.0, 1.5, 0xef4444, { outline: false });
  g(9.68, 10.2, 0.63, 0.65, 1.72, 1.77, 0x3a3d4a, { outline: false });
  g(9.68, 10.4, 0.63, 0.65, 1.82, 1.86, 0x3a3d4a, { outline: false });

  P("meeting-wall");
  pic("n", 1.3, 2.3, 1.7, 3.0, "geo", 0xf4f7f8);
  clock("n", 3.15, 2.8, 0.27);
  pic("n", 8.35, 9.55, 1.7, 2.9, "mountain", 0x3a3d4a);
  // Shelf with books and a pot plant above the flip chart
  wb("n", 10.15, 11.85, 2.42, 2.48, 0, 0.3, 0xc98a4a);
  wb("n", 10.3, 10.4, 2.3, 2.42, 0, 0.2, 0x3a3d4a, { outline: false });
  wb("n", 11.6, 11.7, 2.3, 2.42, 0, 0.2, 0x3a3d4a, { outline: false });
  bookRow(10.25, 11.0, 0.08, 0.26, 2.48, 6, 1, 0.34);
  miniPlant(11.4, 0.16, 2.48, 0.1, 0);
  g(11.6, 11.75, 0.1, 0.22, 2.48, 2.6, 0xf0c419);
  // West wall: poster, air conditioner, radiator under the window, evacuation plan
  pic("w", 1.4, 2.6, 1.15, 2.35, "sunset", 0x8a5a3c);
  wb("w", 1.2, 2.9, 2.62, 3.2, 0, 0.3, 0xe8eef0);
  wb("w", 1.28, 2.82, 2.7, 2.78, 0.3, 0.315, 0x9aa3ab, { outline: false });
  wb("w", 2.55, 2.75, 3.1, 3.15, 0.3, 0.32, 0x4ade80, { outline: false });
  wb("w", 3.3, 6.7, 0.18, 0.8, 0, 0.12, 0xf4f7f8);
  for (let z = 3.5; z < 6.6; z += 0.5) wb("w", z, z + 0.04, 0.22, 0.76, 0.12, 0.125, 0xd5dde1, { outline: false });
  wb("w", 3.3, 6.7, 0.8, 0.83, 0, 0.14, 0xd5dde1, { outline: false });
  pic("w", 10.12, 10.88, 1.95, 2.65, "map", 0xf4f7f8);

  // ======================================================================
  // OPEN SPACE (gx 12–26, gz 0–11)
  // ======================================================================
  P("open-rugs");
  rug(13.4, 18.6, 1.5, 6.5, 0x7798a3, 0x93b2bc, 0.15);
  rug(19.4, 24.6, 1.5, 6.5, 0x7798a3, 0x93b2bc, 0.15);

  P("desks");
  const T = 0.755;
  DESKS.forEach((cfg, idx) => {
    const south = cfg.gz === 4;
    // Slot helper: u across the desk (0..2), v along it (0..1)
    const d = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, color: number, o?: Opts) =>
      g(cfg.gx + u0, cfg.gx + u1, cfg.gz + v0, cfg.gz + v1, y0, y1, color, o);
    const wx = (u: number) => cfg.gx + u - 20;
    const wz = (v: number) => cfg.gz + v - 10;

    // Monitor stand, so the existing monitor no longer floats
    d(0.95, 1.05, 0.105, 0.145, T + 0.02, 0.95, 0x2b2f3a, { outline: false });
    d(0.84, 1.16, 0.05, 0.24, T, T + 0.025, 0x2b2f3a);
    // Mouse and mouse mat
    d(1.28, 1.38, 0.5, 0.62, T, T + 0.03, DARK, { outline: false });
    // Desk lamp head on the existing pole
    d(1.69, 1.86, 0.06, 0.19, T, T + 0.03, 0x2b2f3a);
    if (cfg.cone) {
      d(1.64, 1.91, 0.02, 0.27, 1.05, 1.1, cfg.shade);
      d(1.69, 1.86, 0.05, 0.22, 1.1, 1.15, cfg.shade);
    } else {
      d(1.62, 1.93, 0.0, 0.34, 1.08, 1.14, cfg.shade);
    }
    // Stickies on the monitor
    cfg.notes.forEach(([c, u, y]) => d(u, u + 0.12, 0.162, 0.172, y, y + 0.11, c, { outline: false }));

    // Left-back slot: second screen, laptop, plant, books or a frame
    switch (cfg.lb) {
      case "monitor":
        d(0.12, 0.64, 0.1, 0.15, 0.95, 1.25, DARK);
        d(0.16, 0.6, 0.15, 0.16, 1.0, 1.2, 0x77eaff, { outline: false });
        d(0.2, 0.5, 0.162, 0.168, 1.08, 1.11, 0xdff7ff, { outline: false });
        d(0.2, 0.56, 0.05, 0.24, T, T + 0.025, 0x2b2f3a);
        break;
      case "laptop":
        d(0.1, 0.62, 0.14, 0.52, T, T + 0.022, SILVER);
        d(0.14, 0.58, 0.22, 0.46, T + 0.022, T + 0.026, 0xaab4bd, { outline: false });
        if (south) {
          d(0.1, 0.62, 0.1, 0.14, T, T + 0.27, SILVER);
          d(0.14, 0.58, 0.14, 0.145, T + 0.04, T + 0.25, 0x77eaff, { outline: false });
        } else {
          d(0.1, 0.62, 0.52, 0.56, T, T + 0.27, SILVER);
          d(0.34, 0.38, 0.56, 0.565, T + 0.12, T + 0.16, 0xffffff, { outline: false });
        }
        break;
      case "plant":
        miniPlant(cfg.gx + 0.36, cfg.gz + 0.3, T, 0.1, idx);
        miniPlant(cfg.gx + 0.18, cfg.gz + 0.5, T, 0.06, idx + 1);
        break;
      case "books":
        d(0.12, 0.6, 0.12, 0.42, T, T + 0.05, 0xc3182a);
        d(0.14, 0.56, 0.14, 0.4, T + 0.05, T + 0.1, 0x3b82f6);
        d(0.18, 0.58, 0.16, 0.38, T + 0.1, T + 0.14, 0xf0c419);
        break;
      case "frame":
        d(0.18, 0.5, 0.2, 0.23, T, T + 0.26, 0xd4a537);
        d(0.22, 0.46, 0.23, 0.235, T + 0.04, T + 0.22, 0x9fcf7a, { outline: false });
        break;
      default:
        break;
    }

    // Left-front slot
    if (cfg.lf === "papers") {
      d(0.2, 0.58, 0.58, 0.94, T, T + 0.03, PAPER, { outline: false });
      d(0.23, 0.61, 0.56, 0.92, T + 0.06, T + 0.09, 0xe8f1f8, { outline: false });
      d(0.3, 0.38, 0.65, 0.73, T + 0.09, T + 0.1, 0xef4444, { outline: false });
    } else if (cfg.lf === "phones") {
      d(0.16, 0.24, 0.68, 0.84, T, T + 0.1, 0xe11d48);
      d(0.46, 0.54, 0.68, 0.84, T, T + 0.1, 0xe11d48);
      d(0.24, 0.46, 0.73, 0.79, T, T + 0.03, DARK, { outline: false });
    } else if (cfg.lf === "books") {
      d(0.14, 0.58, 0.62, 0.92, T, T + 0.05, TEAL);
      d(0.18, 0.54, 0.64, 0.9, T + 0.05, T + 0.1, 0xf48fb1);
    }

    // Notepad and pen in the middle front
    if (cfg.notepad) {
      d(0.78, 1.1, 0.74, 0.96, T, T + 0.022, 0xfef08a, { outline: false });
      d(1.12, 1.3, 0.8, 0.84, T, T + 0.02, 0x3b82f6, { outline: false });
    }

    // Right-back slot
    const rbU = 1.46, rbV = 0.3;
    if (cfg.rb === "plant") {
      miniPlant(wx(rbU) + 20, wz(rbV) + 10, T, 0.09, idx);
    } else if (cfg.rb === "cactus") {
      d(rbU - 0.07, rbU + 0.07, rbV - 0.07, rbV + 0.07, T, T + 0.1, 0xcb614b);
      d(rbU - 0.04, rbU + 0.04, rbV - 0.04, rbV + 0.04, T + 0.1, T + 0.3, 0x4f9a5a, { outline: false });
      d(rbU - 0.1, rbU - 0.04, rbV - 0.025, rbV + 0.025, T + 0.18, T + 0.23, 0x4f9a5a, { outline: false });
      d(rbU - 0.1, rbU - 0.07, rbV - 0.025, rbV + 0.025, T + 0.23, T + 0.28, 0x4f9a5a, { outline: false });
      d(rbU - 0.02, rbU + 0.02, rbV - 0.02, rbV + 0.02, T + 0.3, T + 0.33, 0xf48fb1, { outline: false });
    } else if (cfg.rb === "duck") {
      d(rbU - 0.09, rbU + 0.09, rbV - 0.07, rbV + 0.07, T, T + 0.09, 0xf9d71c);
      blob(scene, wx(rbU + 0.05), T + 0.15, wz(rbV + 0.03), 0.06, 0xf9d71c);
      d(rbU + 0.08, rbU + 0.13, rbV + 0.0, rbV + 0.06, T + 0.12, T + 0.15, 0xf08c1e, { outline: false });
    } else if (cfg.rb === "frame") {
      d(rbU - 0.12, rbU + 0.1, rbV - 0.02, rbV + 0.02, T, T + 0.2, 0xd4a537);
      d(rbU - 0.09, rbU + 0.07, rbV + 0.02, rbV + 0.025, T + 0.03, T + 0.17, 0x81d4fa, { outline: false });
    } else {
      // little robot figurine
      d(rbU - 0.08, rbU + 0.08, rbV - 0.07, rbV + 0.07, T, T + 0.16, TEAL);
      d(rbU - 0.06, rbU + 0.06, rbV - 0.06, rbV + 0.06, T + 0.16, T + 0.27, 0xcfd8dd);
      d(rbU - 0.04, rbU - 0.01, rbV + 0.06, rbV + 0.065, T + 0.2, T + 0.23, 0x282a36, { outline: false });
      d(rbU + 0.01, rbU + 0.04, rbV + 0.06, rbV + 0.065, T + 0.2, T + 0.23, 0x282a36, { outline: false });
      d(rbU - 0.01, rbU + 0.01, rbV - 0.01, rbV + 0.01, T + 0.27, T + 0.34, DARK, { outline: false });
    }

    // Mug front right: body, handle, coffee
    const mu = 1.5, mv = 0.76;
    d(mu - 0.07, mu + 0.07, mv - 0.07, mv + 0.07, T, T + 0.14, cfg.mug);
    d(mu + 0.07, mu + 0.12, mv - 0.02, mv + 0.02, T + 0.04, T + 0.11, cfg.mug, { outline: false });

    // Pedestal under the desk (inside the desk footprint)
    const pu0 = cfg.ped === "R" ? 1.25 : 0.3, pu1 = pu0 + 0.5;
    d(pu0, pu1, 0.15, 0.85, 0.08, 0.69, 0xc27e4a);
    if (south) {
      [[0.5, 0.66], [0.31, 0.47], [0.12, 0.28]].forEach(([y0, y1]) => {
        d(pu0 + 0.03, pu1 - 0.03, 0.85, 0.865, y0!, y1!, 0xd9a066, { outline: false });
      });
    }
  });

  P("dividers");
  // Notes, a photo and a calendar pinned on the south faces of the two low dividers (faces at gz 4.05)
  const divNotes: Array<[number, number, number, number, number]> = [
    [14.4, 0.8, 0.98, 0xfef08a, 0.12], [14.7, 0.86, 1.04, 0xf48fb1, 0.12], [15.4, 0.8, 1.0, 0x81d4fa, 0.12],
    [17.3, 0.8, 1.0, 0xfef08a, 0.12],
    [20.4, 0.84, 1.0, 0xf48fb1, 0.12], [22.5, 0.82, 1.0, 0x81d4fa, 0.12],
  ];
  divNotes.forEach(([gx, y0, y1, c, w]) => g(gx, gx + w, 4.052, 4.062, y0, y1, c, { outline: false }));
  g(15.0, 15.34, 4.052, 4.062, 0.8, 1.1, PAPER, { outline: false });
  g(15.04, 15.3, 4.062, 4.07, 0.98, 1.06, 0xef4444, { outline: false });
  g(15.06, 15.28, 4.062, 4.07, 0.84, 0.95, 0xe6e9ee, { outline: false });
  g(21.7, 21.98, 4.052, 4.062, 0.8, 1.08, 0xe8b923, { outline: false });
  g(21.74, 21.94, 4.062, 4.07, 0.84, 1.04, 0x9fcf7a, { outline: false });

  P("north-wall-open");
  // Gap gx 12–13: locker bank and an abstract poster
  [TEAL, 0xcb614b, 0x64748b].forEach((c, i) => {
    const x0 = 12.2 + i * 0.25;
    g(x0, x0 + 0.25, 0.05, 0.5, 0, 1.85, c);
    g(x0 + 0.05, x0 + 0.2, 0.5, 0.507, 1.6, 1.66, 0x282a36, { outline: false });
  });
  g(12.2, 12.95, 0.05, 0.5, 1.85, 1.9, 0x3a3d4a);
  pic("n", 12.25, 12.9, 2.1, 3.25, "stripes", 0xf4f7f8);
  // Gap gx 16–17: filing cabinet with a plant, a picture above
  g(16.15, 16.85, 0.05, 0.55, 0, 1.3, 0xaab4bd);
  [0.06, 0.34, 0.62, 0.9].forEach((y) => {
    g(16.2, 16.8, 0.55, 0.565, y, y + 0.24, 0xc3ccd3, { outline: false });
    g(16.38, 16.62, 0.565, 0.58, y + 0.1, y + 0.13, DARK, { outline: false });
  });
  miniPlant(16.35, 0.3, 1.3, 0.1, 1);
  g(16.55, 16.75, 0.2, 0.4, 1.3, 1.42, 0xc98a4a);
  pic("n", 16.2, 16.8, 1.8, 2.6, "plant", 0x8a5a3c);
  // Gap gx 20–21: bookcase with a clock above
  g(20.1, 20.14, 0.05, 0.46, 0, 1.86, 0x805242);
  g(20.86, 20.9, 0.05, 0.46, 0, 1.86, 0x805242);
  g(20.14, 20.86, 0.05, 0.1, 0.0, 1.86, 0x5e3721, { outline: false });
  [0.0, 0.5, 0.95, 1.4].forEach((y) => g(20.14, 20.86, 0.1, 0.46, y, y + 0.04, 0x9a6a50));
  g(20.1, 20.9, 0.05, 0.46, 1.86, 1.9, 0x805242);
  bookRow(20.16, 20.84, 0.12, 0.4, 0.09, 6, 0, 0.34);
  bookRow(20.16, 20.84, 0.12, 0.4, 0.99, 6, 3, 0.32);
  g(20.18, 20.42, 0.12, 0.4, 1.44, 1.7, 0xf4ead2, { outline: false });
  g(20.46, 20.8, 0.12, 0.4, 1.44, 1.62, 0x3b82f6);
  g(20.5, 20.7, 0.12, 0.4, 0.54, 0.74, 0xc9a06a);
  g(20.2, 20.4, 0.12, 0.4, 0.54, 0.64, 0xe11d48);
  clock("n", 20.5, 2.6, 0.27);
  // Under the windows: radiators, a long planter, low cabinets (everything stays below the 0.9 sill)
  for (const [x0, x1] of [[13.2, 15.8]] as const) {
    g(x0, x1, 0.05, 0.2, 0.15, 0.75, 0xf4f7f8);
    for (let x = x0 + 0.2; x < x1 - 0.1; x += 0.4) g(x, x + 0.05, 0.2, 0.205, 0.2, 0.7, 0xd5dde1, { outline: false });
    g(x0, x1, 0.05, 0.22, 0.75, 0.78, 0xd5dde1, { outline: false });
  }
  g(17.2, 19.8, 0.05, 0.5, 0, 0.4, 0xc98a4a);
  g(17.24, 19.76, 0.09, 0.46, 0.4, 0.43, 0x5a3d2b, { outline: false });
  for (let i = 0; i < 7; i++) {
    const x = 17.4 + i * 0.34;
    blob(scene, x - 20, 0.6 + (i % 2) * 0.08, 0.28 - 10, 0.22 + (i % 3) * 0.02, i % 2 ? LEAF : LEAF_DARK, 1.0);
  }
  blob(scene, 18.5 - 20, 0.72, 0.3 - 10, 0.2, 0x81b352);
  [21.2, 22.07].forEach((x0, i) => {
    g(x0, x0 + 0.87, 0.05, 0.5, 0, 0.78, 0xf2e4c9);
    g(x0 - 0.01, x0 + 0.88, 0.04, 0.52, 0.78, 0.82, 0xe9a964);
    if (i === 0) {
      g(x0 + 0.1, x0 + 0.5, 0.15, 0.4, 0.82, 0.88, PAPER, { outline: false });
      g(x0 + 0.14, x0 + 0.54, 0.17, 0.42, 0.88, 0.91, CREAM, { outline: false });
    } else {
      miniPlant(x0 + 0.4, 0.28, 0.82, 0.07, 1);
    }
  });
  g(23.0, 23.8, 0.05, 0.5, 0, 0.78, 0xf2e4c9);
  g(22.99, 23.81, 0.04, 0.52, 0.78, 0.82, 0xe9a964);

  P("open-floor");
  // Copier station along the meeting glass: copier, paper boxes, a big ficus
  g(12.4, 13.3, 7.2, 8.5, 0, 0.75, 0xe8eef0);
  g(12.4, 13.3, 7.2, 8.5, 0.75, 1.0, 0xcfd8dd);
  g(12.38, 13.32, 7.18, 8.52, 1.0, 1.06, 0x9aa3ab);
  g(13.3, 13.34, 7.3, 8.4, 0.15, 0.32, 0x6fa8b0, { outline: false });
  g(13.3, 13.34, 7.3, 8.4, 0.38, 0.55, 0x6fa8b0, { outline: false });
  g(13.3, 13.34, 7.3, 7.5, 0.82, 0.92, 0x3a3d4a, { outline: false });
  g(12.9, 13.28, 7.22, 7.62, 1.06, 1.1, DARK);
  g(13.0, 13.2, 7.3, 7.5, 1.1, 1.103, 0x77eaff, { outline: false });
  [0x4ade80, 0xef4444, 0xf0c419].forEach((c, i) => g(12.95 + i * 0.1, 13.02 + i * 0.1, 7.52, 7.58, 1.1, 1.105, c, { outline: false }));
  g(12.5, 13.2, 8.5, 8.72, 0.5, 0.53, 0x9aa3ab, { outline: false });
  g(12.6, 13.1, 8.5, 8.7, 0.53, 0.56, PAPER, { outline: false });
  g(12.5, 12.9, 7.7, 8.1, 1.06, 1.12, PAPER, { outline: false });
  g(12.45, 12.95, 8.7, 9.15, 0, 0.3, 0xe6cfaf);
  g(12.47, 12.93, 8.72, 9.13, 0.3, 0.58, 0xd1b893);
  g(12.5, 12.9, 8.75, 9.1, 0.58, 0.64, PAPER, { outline: false });
  // big ficus
  g(12.7, 13.2, 6.05, 6.55, 0, 0.42, TEAL);
  g(12.74, 13.16, 6.09, 6.51, 0.42, 0.44, 0x5a3d2b, { outline: false });
  g(12.91, 12.99, 6.27, 6.35, 0.44, 1.1, 0x8a5a3c, { outline: false });
  [[12.95, 1.2, 6.3, 0.42, LEAF], [13.12, 1.58, 6.38, 0.3, LEAF_DARK], [12.8, 1.55, 6.2, 0.3, LEAF], [12.98, 1.9, 6.3, 0.24, 0x81b352], [12.72, 1.15, 6.4, 0.22, LEAF_DARK]].forEach(([x, y, z, r, c]) =>
    blob(scene, (x as number) - 20, y as number, (z as number) - 10, r as number, c as number, 1.15)
  );
  // Kanban board on a mobile stand, columns and sticky notes
  g(22.15, 22.45, 6.98, 7.4, 0, 0.06, DARK);
  g(23.95, 24.25, 6.98, 7.4, 0, 0.06, DARK);
  g(22.28, 22.36, 7.1, 7.18, 0.06, 0.8, 0xb8bcc4);
  g(24.04, 24.12, 7.1, 7.18, 0.06, 0.8, 0xb8bcc4);
  g(22.2, 24.2, 7.05, 7.15, 0.75, 1.95, 0xc0c6cc);
  g(22.28, 24.12, 7.15, 7.16, 0.83, 1.87, 0xffffff, { outline: false });
  [[22.34, 22.9, 0xf48fb1], [22.96, 23.52, 0xf9e05c], [23.58, 24.1, 0x4ade80]].forEach(([a, b, c]) =>
    g(a as number, b as number, 7.16, 7.168, 1.66, 1.8, c as number, { outline: false })
  );
  for (const x of [22.93, 23.55]) g(x, x + 0.025, 7.16, 7.165, 0.85, 1.64, 0xc0c6cc, { outline: false });
  const kan: Array<[number, number, number]> = [
    [22.4, 1.4, 0xfef08a], [22.64, 1.4, 0xf48fb1], [22.4, 1.16, 0x81d4fa], [22.64, 1.16, 0xfef08a], [22.4, 0.92, 0xa5d6a7],
    [23.02, 1.4, 0xfef08a], [23.26, 1.4, 0x81d4fa], [23.02, 1.16, 0xf48fb1],
    [23.66, 1.4, 0xa5d6a7], [23.9, 1.4, 0xa5d6a7], [23.66, 1.16, 0xfef08a], [23.9, 1.16, 0x81d4fa], [23.66, 0.92, 0xa5d6a7],
  ];
  kan.forEach(([x, y, c]) => g(x, x + 0.18, 7.17, 7.18, y, y + 0.18, c, { outline: false }));
  g(22.7, 23.7, 7.15, 7.28, 0.72, 0.75, 0xe8eef0);
  [0xef4444, 0x3b82f6, 0x4ade80].forEach((c, i) => g(22.9 + i * 0.12, 22.98 + i * 0.12, 7.2, 7.26, 0.75, 0.79, c, { outline: false }));
  // Dog bed with a sleeping dog and its ball
  g(22.3, 23.4, 9.0, 9.8, 0, 0.15, 0xb2485a);
  g(22.42, 23.28, 9.12, 9.68, 0.15, 0.2, 0xf2c4cd, { outline: false });
  blob(scene, 22.85 - 20, 0.34, 9.4 - 10, 0.25, 0xe8c89a, 0.6);
  blob(scene, 23.12 - 20, 0.3, 9.48 - 10, 0.14, 0xe8c89a, 0.9);
  g(23.0, 23.06, 9.5, 9.58, 0.34, 0.46, 0x8a5a3c, { outline: false });
  g(23.18, 23.24, 9.5, 9.58, 0.34, 0.46, 0x8a5a3c, { outline: false });
  blob(scene, 22.6 - 20, 0.28, 9.32 - 10, 0.09, 0xe8c89a, 0.8);
  blob(scene, 23.7 - 20, 0.07, 9.5 - 10, 0.07, 0xe11d48);
  // Water-bottle crate, a coat stand and a second big plant
  g(14.0, 14.8, 9.4, 9.9, 0, 0.28, 0x3a3d4a);
  [14.12, 14.4, 14.65].forEach((x) => {
    g(x - 0.1, x + 0.1, 9.5, 9.7, 0.28, 0.78, 0x4dbfe1, { opacity: 0.85 });
    g(x - 0.05, x + 0.05, 9.55, 9.65, 0.78, 0.86, 0x2b7fb0, { outline: false });
  });
  g(12.5, 12.9, 9.45, 9.85, 0, 0.05, 0x8a5a3c);
  g(12.67, 12.73, 9.62, 9.68, 0.05, 1.7, 0x8a5a3c);
  g(12.45, 12.95, 9.6, 9.7, 1.65, 1.71, 0x8a5a3c);
  g(12.45, 12.68, 9.45, 9.85, 0.85, 1.6, 0x3e5c8a);
  g(12.72, 12.95, 9.5, 9.85, 0.95, 1.5, 0xf0c419);
  bigPlant(13.3, 1.4, 0, 0.9);
  // Bins by the desk clusters: general waste and recycling
  g(13.35, 13.75, 3.6, 4.0, 0, 0.55, 0x6b7280);
  g(13.33, 13.77, 3.58, 4.02, 0.55, 0.6, 0x4b5563);
  g(13.45, 13.65, 3.7, 3.9, 0.6, 0.64, PAPER, { outline: false });
  g(19.55, 19.95, 4.3, 4.7, 0, 0.55, 0x3f9e5a);
  g(19.53, 19.97, 4.28, 4.72, 0.55, 0.6, 0x2d7a44);
  g(19.62, 19.88, 4.7, 4.715, 0.3, 0.36, PAPER, { outline: false });

  // ======================================================================
  // CORRIDOR (gz 11–13)
  // ======================================================================
  P("corridor");
  rug(3.0, 31.0, 11.5, 12.5, 0x93a8b5, 0xa4b8c3, 0.1);
  // Frosted privacy film on the meeting glass: a band with a row of dots
  for (const [x0, x1] of [[0.1, 8.4], [10.6, 11.9]] as const) {
    g(x0, x1, 11.125, 11.14, 1.0, 1.5, 0xffffff, { outline: false, opacity: 0.75 });
    g(x0, x1, 11.14, 11.145, 1.2, 1.24, 0xcfe6ee, { outline: false });
  }
  g(12.125, 12.14, 0.1, 10.9, 1.0, 1.5, 0xffffff, { outline: false, opacity: 0.75 });
  g(12.14, 12.145, 0.1, 10.9, 1.2, 1.24, 0xcfe6ee, { outline: false });
  // Benches against the glass (west) and under the director's wall (east), with cushions
  const bench = (x0: number, x1: number, cushions: number[]) => {
    g(x0, x1, 11.3, 11.74, 0.4, 0.46, 0xde985d);
    g(x0, x1, 11.27, 11.34, 0.46, 0.92, 0xc98a4a);
    for (const x of [x0 + 0.15, x1 - 0.2]) g(x, x + 0.05, 11.36, 11.7, 0, 0.4, DARK, { outline: false });
    cushions.forEach((c, i) => g(x0 + 0.2 + i * 0.5, x0 + 0.62 + i * 0.5, 11.38, 11.68, 0.46, 0.56, c));
  };
  bench(1.8, 3.6, [TEAL, 0xcb614b]);
  bench(37.0, 38.8, [0xf0c419, TEAL]);
  g(2.9, 3.3, 11.45, 11.62, 0.46, 0.5, 0xf48fb1, { outline: false }); // magazine
  // Umbrella stand by the meeting door
  g(11.2, 11.6, 11.3, 11.7, 0, 0.5, DARK);
  [[11.28, 0x3b82f6], [11.4, 0xe11d48], [11.5, 0xf0c419]].forEach(([x, c], i) => {
    g(x as number, (x as number) + 0.05, 11.45 + (i % 2) * 0.08, 11.5 + (i % 2) * 0.08, 0.5, 1.0 + i * 0.05, c as number, { outline: false });
    g((x as number) - 0.03, (x as number) + 0.08, 11.45 + (i % 2) * 0.08, 11.5 + (i % 2) * 0.08, 1.0 + i * 0.05, 1.05 + i * 0.05, 0x3a3d4a, { outline: false });
  });
  // Wet floor sign
  g(15.0, 15.4, 12.5, 12.55, 0.04, 0.62, 0xf9d71c);
  g(15.0, 15.4, 12.66, 12.71, 0.04, 0.62, 0xe0b80f);
  g(15.0, 15.4, 12.5, 12.71, 0.6, 0.65, 0xe0b80f);
  g(15.15, 15.25, 12.55, 12.56, 0.3, 0.52, DARK, { outline: false });
  g(15.17, 15.23, 12.55, 12.56, 0.52, 0.58, DARK, { outline: false });
  // Director's wall, corridor side: notice board, pictures, evacuation plan, fire extinguisher
  wb("c", 27.0, 29.4, 0.5, 1.2, 0, 0.05, 0xb8bcc4);
  wb("c", 27.06, 29.34, 0.56, 1.14, 0.05, 0.06, 0xc9a06a, { outline: false });
  const memos: Array<[number, number, number, number]> = [
    [27.15, 0.8, 0xf8fafc, 0.3], [27.55, 0.66, 0xf48fb1, 0.22], [27.9, 0.78, 0xfef08a, 0.26], [28.3, 0.64, 0x81d4fa, 0.3], [28.75, 0.8, 0xf8fafc, 0.28],
  ];
  memos.forEach(([u, y, c, w]) => {
    wb("c", u, u + w, y, y + 0.28, 0.06, 0.066, c, { outline: false });
  });
  pic("c", 30.0, 31.2, 0.55, 1.2, "sunset", 0xe8b923);
  pic("c", 31.6, 32.5, 0.55, 1.2, "geo", 0xf4f7f8);
  wb("c", 37.0, 37.8, 0.55, 1.25, 0, 0.05, 0xf4f7f8);
  wb("c", 37.06, 37.74, 0.61, 1.19, 0.05, 0.056, 0xd9f2e0, { outline: false });
  wb("c", 37.15, 37.65, 0.7, 1.1, 0.056, 0.062, 0xffffff, { outline: false });
  wb("c", 37.2, 37.35, 0.75, 0.85, 0.062, 0.068, 0x4ade80, { outline: false });
  wb("c", 37.2, 37.6, 0.9, 0.95, 0.062, 0.068, 0x4ade80, { outline: false });
  wb("c", 37.45, 37.6, 1.0, 1.05, 0.062, 0.068, 0xef4444, { outline: false });
  wb("c", 38.05, 38.45, 0.4, 1.12, 0, 0.04, 0xf4f7f8);
  g(38.12, 38.38, 11.21, 11.4, 0.45, 0.95, 0xd62828);
  g(38.17, 38.33, 11.23, 11.38, 0.95, 1.02, DARK);
  g(38.21, 38.29, 11.3, 11.38, 1.02, 1.08, DARK, { outline: false });
  g(38.13, 38.37, 11.4, 11.405, 0.62, 0.78, PAPER, { outline: false });
  wb("c", 38.1, 38.4, 1.1, 1.32, 0, 0.03, 0xd62828);
  wb("c", 38.2, 38.3, 1.14, 1.28, 0.03, 0.036, 0xffffff, { outline: false });
  // West end of the corridor: a picture above the plant
  pic("w", 11.5, 12.5, 1.8, 2.7, "chart", 0x3a3d4a);
}
