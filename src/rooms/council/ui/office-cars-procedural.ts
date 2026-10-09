import type * as ThreeNS from "three";
import type { PropsKit } from "./office-props-kit";

/**
 * Seven stylised cars built from code, no model files. Each car is traced from its orthographic
 * blueprint: the side silhouette is read in blueprint pixels, mapped to world units by a frame, and
 * turned into lofted hulls (a section per z step, so the side profile, the plan view and the
 * tumblehome all come from small functions). Glass, stripes and lamps are thin pieces slightly
 * proud of the body; the pixel pass draws the outlines, so there are no edge lines.
 * Local +Z is the front, wheels stand on y = 0, `group.userData.wheels` lists the four wheel groups
 * (spin them about x).
 */
export type CarModel = "mustang" | "raptor" | "gwagon" | "p911" | "supercar" | "cybertruck" | "vwbus";

export const CAR_MODELS: readonly CarModel[] = ["mustang", "raptor", "gwagon", "p911", "supercar", "cybertruck", "vwbus"];

/** Length, width and height in world units each car is built to. */
export const CAR_SIZES: Record<CarModel, readonly [number, number, number]> = {
  mustang: [4.6, 1.8, 1.3],
  raptor: [5.6, 2.2, 2.0],
  gwagon: [4.8, 2.0, 2.0],
  p911: [4.3, 1.8, 1.3],
  supercar: [4.6, 2.1, 1.15],
  cybertruck: [5.7, 2.1, 1.9],
  vwbus: [4.4, 1.8, 2.0],
};

type Pt = [number, number];
/** A function of z; `keys` are the z values where it bends, so the loft puts a section there. */
type Fn = ((z: number) => number) & { keys?: number[] };
type F = number | Fn;

const DARK = 0x1c1e24;

/** Piecewise-linear function through (z, value) points. */
const pl = (pts: Pt[]): Fn => {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const f: Fn = (z) => {
    const first = p[0] as Pt;
    const last = p[p.length - 1] as Pt;
    if (z <= first[0]) return first[1];
    if (z >= last[0]) return last[1];
    let i = 1;
    while ((p[i] as Pt)[0] < z) i++;
    const a = p[i - 1] as Pt;
    const b = p[i] as Pt;
    return b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (z - a[0])) / (b[0] - a[0]);
  };
  f.keys = p.map((q) => q[0]);
  return f;
};

/** `f` plus a constant, same bend points. */
const off = (f: Fn, d: number): Fn => {
  const g: Fn = (z) => f(z) + d;
  g.keys = f.keys;
  return g;
};

/** Function of z built from other functions, bending where `from` bends. */
const derive = (from: Fn, g: (z: number) => number): Fn => {
  const h: Fn = (z) => g(z);
  h.keys = from.keys;
  return h;
};

const val = (v: F | undefined, z: number, d: number): number => (v === undefined ? d : typeof v === "number" ? v : v(z));

/** Blueprint pixels to world units: `xA`/`xB` are the pixel columns of the two car ends. */
const frame = (xA: number, xB: number, yG: number, len: number, frontRight: boolean, ky = 1) => {
  const k = len / Math.abs(xB - xA);
  const xc = (xA + xB) / 2;
  const z = (px: number) => (frontRight ? px - xc : xc - px) * k;
  const y = (py: number) => (yG - py) * k * ky;
  return {
    z,
    y,
    pts: (a: Pt[]): Pt[] => a.map(([px, py]) => [z(px), y(py)] as Pt),
    pl: (a: Pt[]): Fn => pl(a.map(([px, py]) => [z(px), y(py)] as Pt)),
  };
};

/** Arch cut-out points for an underside function: a half polygon over the wheel, vertical walls to `base`. */
const arch = (cz: number, cy: number, R: number, base: number, n = 6): Pt[] => {
  const out: Pt[] = [[cz - R - 0.004, base]];
  for (let i = 0; i <= n; i++) {
    const a = Math.PI - (Math.PI * i) / n;
    out.push([cz + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  out.push([cz + R + 0.004, base]);
  return out;
};

type Ctx = {
  kit: PropsKit;
  T: typeof import("three");
  g: ThreeNS.Group;
  name: string;
  wheels: ThreeNS.Object3D[];
};

type LoftOpts = {
  z0: number;
  z1: number;
  /** Underside and top of the hull along z. */
  y0: F;
  y1: F;
  /** Half width at the shoulder; `hb` at the underside and `ht` at the top default to slimmer values. */
  hw: F;
  hb?: F;
  ht?: F;
  /** Shoulder height as a fraction of y0..y1, or absolute with `ym`. */
  mid?: F;
  ym?: F;
  step?: number;
  keys?: number[];
  color: number;
};

const sampleZs = (o: LoftOpts): number[] => {
  const zs: number[] = [o.z0, o.z1];
  const add = (k: number) => {
    if (k > o.z0 + 1e-4 && k < o.z1 - 1e-4) zs.push(k);
  };
  for (const v of [o.y0, o.y1, o.hw, o.hb, o.ht, o.mid, o.ym]) {
    if (typeof v === "function" && v.keys) v.keys.forEach(add);
  }
  (o.keys ?? []).forEach(add);
  const step = o.step ?? 0.4;
  for (let z = o.z0 + step; z < o.z1 - 1e-4; z += step) zs.push(z);
  zs.sort((a, b) => a - b);
  return zs.filter((z, i) => i === 0 || z - (zs[i - 1] as number) > 5e-4);
};

/**
 * Hull as a loft of hexagonal sections (underside, shoulder, top), flat shaded. Sections run from
 * z0 (rear) to z1 (front); the side profile is y0/y1, the plan view is hw, the tumblehome hb/ht.
 */
const loftGeometry = (T: typeof import("three"), o: LoftOpts): ThreeNS.BufferGeometry => {
  const zs = sampleZs(o);
  const secs = zs.map((z) => {
    const y0 = val(o.y0, z, 0);
    const y1 = Math.max(y0, val(o.y1, z, y0));
    const hw = val(o.hw, z, 1);
    const hb = val(o.hb, z, hw * 0.94);
    const ht = val(o.ht, z, hw * 0.88);
    const ym = o.ym !== undefined ? Math.min(y1, Math.max(y0, val(o.ym, z, y1))) : y0 + (y1 - y0) * val(o.mid, z, 0.62);
    const poly: Array<[number, number]> = [[-hb, y0], [hb, y0], [hw, ym], [ht, y1], [-ht, y1], [-hw, ym]];
    return { z, poly };
  });
  const pos: number[] = [];
  const nor: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-7) return;
    nx /= len; ny /= len; nz /= len;
    pos.push(...a, ...b, ...c);
    nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  };
  for (let i = 0; i + 1 < secs.length; i++) {
    const a = secs[i]!, b = secs[i + 1]!;
    for (let j = 0; j < 6; j++) {
      const j2 = (j + 1) % 6;
      const a0 = [a.poly[j]![0], a.poly[j]![1], a.z], a1 = [a.poly[j2]![0], a.poly[j2]![1], a.z];
      const b0 = [b.poly[j]![0], b.poly[j]![1], b.z], b1 = [b.poly[j2]![0], b.poly[j2]![1], b.z];
      tri(a0, a1, b1);
      tri(a0, b1, b0);
    }
  }
  const cap = (s: (typeof secs)[number], front: boolean) => {
    const cx = 0;
    const cy = s.poly.reduce((m, p) => m + p[1], 0) / 6;
    for (let j = 0; j < 6; j++) {
      const p = s.poly[j]!, q = s.poly[(j + 1) % 6]!;
      if (front) tri([cx, cy, s.z], [p[0], p[1], s.z], [q[0], q[1], s.z]);
      else tri([cx, cy, s.z], [q[0], q[1], s.z], [p[0], p[1], s.z]);
    }
  };
  cap(secs[0]!, false);
  cap(secs[secs.length - 1]!, true);
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new T.Float32BufferAttribute(nor, 3));
  return geo;
};

const addMesh = (c: Ctx, geo: ThreeNS.BufferGeometry, color: number): ThreeNS.Mesh => {
  c.kit.disposables.push(geo);
  const m = new c.T.Mesh(geo, c.kit.material(color));
  m.name = c.name;
  c.g.add(m);
  return m;
};

const loft = (c: Ctx, o: LoftOpts) => addMesh(c, loftGeometry(c.T, o), o.color);

/** Raised band that follows the top of a hull (stripes, glass, vents); mirrored when `xc` is not 0. */
const strip = (c: Ctx, top: Fn, za: number, zb: number, xc: number, hw: F, color: number, lift = 0.03) => {
  const z0 = Math.min(za, zb), z1 = Math.max(za, zb);
  const o: LoftOpts = { z0, z1, y0: derive(top, (z) => top(z) - 0.03), y1: derive(top, (z) => top(z) + lift), hw, hb: hw, ht: hw, mid: 0.5, step: 0.3, keys: top.keys, color };
  const geo = loftGeometry(c.T, o);
  const m = addMesh(c, geo, color);
  m.position.x = xc;
  if (xc !== 0) {
    const m2 = new c.T.Mesh(geo, c.kit.material(color));
    m2.name = c.name;
    m2.position.x = -xc;
    c.g.add(m2);
  }
  return m;
};

/** Polygon in the (z, y) side plane extruded across x, centred on x = 0. */
const sideGeometry = (T: typeof import("three"), pts: Pt[], depth: number): ThreeNS.BufferGeometry => {
  const shape = new T.Shape(pts.map(([z, y]) => new T.Vector2(z, y)));
  const geo = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(-Math.PI / 2);
  return geo;
};

/** The same side polygon on both flanks of the car, `x` is the flank plane. */
const side = (c: Ctx, pts: Pt[], x: number, color: number, thick = 0.05) => {
  const geo = sideGeometry(c.T, pts, thick);
  const a = addMesh(c, geo, color);
  a.position.x = x;
  const b = new c.T.Mesh(geo, c.kit.material(color));
  b.name = c.name;
  b.position.x = -x;
  c.g.add(b);
};

/** Polygon in the (x, y) front plane extruded along +z from z0. */
const faceGeometry = (T: typeof import("three"), pts: Pt[], z0: number, depth: number): ThreeNS.BufferGeometry => {
  const shape = new T.Shape(pts.map(([x, y]) => new T.Vector2(x, y)));
  const geo = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, z0);
  return geo;
};

const bx = (c: Ctx, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number) => {
  const m = c.kit.box(c.g, Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1), Math.min(z0, z1), Math.max(z0, z1), color);
  m.name = c.name;
  return m;
};

/** Box on both flanks: `xi`..`xo` are positive x bounds. */
const bxm = (c: Ctx, xi: number, xo: number, y0: number, y1: number, z0: number, z1: number, color: number) => {
  bx(c, xi, xo, y0, y1, z0, z1, color);
  bx(c, -xo, -xi, y0, y1, z0, z1, color);
};

/** Round lamp on the front or rear face: a short cylinder along z facing `dir`. */
const lamp = (c: Ctx, x: number, y: number, z: number, r: number, depth: number, color: number, dir: 1 | -1 = 1, seg = 10) => {
  const geo = new c.T.CylinderGeometry(r, r, depth, seg);
  geo.rotateX(Math.PI / 2);
  const m = addMesh(c, geo, color);
  m.position.set(x, y, z + (dir * depth) / 2);
  return m;
};

type WheelOpts = {
  r: number;
  w: number;
  tyre: number;
  rim: number;
  hub: number;
  /** Rim radius as a fraction of the tyre radius. */
  rimR?: number;
  rimSeg?: number;
  /** Knobbly tread: a toothed outline instead of a round tyre. */
  teeth?: number;
};

/** One wheel group centred on its axle; the group spins about x. */
const wheel = (c: Ctx, x: number, z: number, o: WheelOpts) => {
  const grp = new c.T.Group();
  grp.name = c.name;
  grp.position.set(x, o.r, z);
  let tyreGeo: ThreeNS.BufferGeometry;
  if (o.teeth) {
    const pts: Pt[] = [];
    const n = o.teeth * 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = i % 2 === 0 ? o.r : o.r - 0.075;
      pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
    }
    tyreGeo = sideGeometry(c.T, pts, o.w);
  } else {
    tyreGeo = new c.T.CylinderGeometry(o.r, o.r, o.w, 14);
    tyreGeo.rotateZ(Math.PI / 2);
  }
  const parts: Array<[ThreeNS.BufferGeometry, number]> = [[tyreGeo, o.tyre]];
  const rimGeo = new c.T.CylinderGeometry(o.r * (o.rimR ?? 0.62), o.r * (o.rimR ?? 0.62), o.w + 0.04, o.rimSeg ?? 8);
  rimGeo.rotateZ(Math.PI / 2);
  parts.push([rimGeo, o.rim]);
  const hubGeo = new c.T.CylinderGeometry(o.r * 0.24, o.r * 0.24, o.w + 0.08, 6);
  hubGeo.rotateZ(Math.PI / 2);
  parts.push([hubGeo, o.hub]);
  for (const [geo, color] of parts) {
    c.kit.disposables.push(geo);
    const m = new c.T.Mesh(geo, c.kit.material(color));
    m.name = c.name;
    grp.add(m);
  }
  c.g.add(grp);
  c.wheels.push(grp);
  return grp;
};

/** The four wheels: `zs` = [front, rear] axle z, `wx` the wheel centre x, `o` per axle. */
const wheels4 = (c: Ctx, zs: [number, number], wx: number, front: WheelOpts, rear: WheelOpts = front) => {
  for (const s of [1, -1]) {
    wheel(c, s * wx, zs[0], front);
    wheel(c, s * wx, zs[1], rear);
  }
};

/** Dark wheel wells and the underbody, so the arches do not show through the hull. */
const chassis = (c: Ctx, axles: number[], cy: number, R: number, hw: number, base: number, z0: number, z1: number, lim?: { hw: Fn; top: Fn }) => {
  for (const z of axles) {
    const x = lim ? Math.min(hw - 0.06, lim.hw(z) * 0.8) : hw - 0.06;
    const top = lim ? Math.min(cy + R - 0.01, lim.top(z) - 0.05) : cy + R - 0.01;
    bx(c, -x, x, 0.05, top, z - R * 0.97, z + R * 0.97, DARK);
  }
  bx(c, -(hw - 0.06), hw - 0.06, 0.05, base + 0.02, z0, z1, DARK);
};

type Builder = (c: Ctx) => void;

// ---------------------------------------------------------------------------------------------
// 1967 Mustang fastback
// ---------------------------------------------------------------------------------------------
const mustang: Builder = (c) => {
  const L = 4.6, HW = 0.9, RED = 0xd9302a, CHROME = 0xc9ccd2, GLASS = 0x34495c, WHITE = 0xf6f4ef;
  const F = frame(297, 1270, 593, L, true);
  const zr = F.z(518), zf = F.z(1095), R = 0.4, cy = 0.33, base = 0.2;
  const zTail = -L / 2, zNose = L / 2 - 0.1;
  const top = F.pl([[297, 430], [305, 415], [340, 411], [600, 412], [640, 418], [930, 418], [1000, 412], [1100, 418], [1200, 426], [1250, 436], [1268, 448]]);
  const y0 = pl([[zTail, 0.3], [zTail + 0.2, base], ...arch(zr, cy, R, base), ...arch(zf, cy, R, base), [zNose, base]]);
  const hw = pl([[zTail, 0.82], [zTail + 0.35, HW], [zNose - 0.6, HW], [zNose, 0.84]]);
  loft(c, { z0: zTail, z1: zNose, y0, y1: top, hw, hb: derive(hw, (z) => hw(z) - 0.06), ht: derive(hw, (z) => hw(z) - 0.12), mid: 0.72, color: RED });

  // Fastback greenhouse
  const cabTop = F.pl([[445, 408], [520, 375], [589, 347], [640, 332], [700, 327], [790, 329], [830, 336], [935, 412]]);
  const cabW = pl([[F.z(445), 0.62], [F.z(589), 0.72], [F.z(905), 0.72], [F.z(935), 0.78]]);
  loft(c, { z0: F.z(445), z1: F.z(935), y0: 0.74, y1: cabTop, hw: cabW, hb: cabW, ht: derive(cabW, (z) => cabW(z) - 0.08), ym: off(cabTop, -0.1), color: RED });
  const gw = derive(cabW, (z) => cabW(z) - 0.06);
  strip(c, cabTop, F.z(850), F.z(932), 0, gw, GLASS, 0.03);
  strip(c, cabTop, F.z(462), F.z(589), 0, gw, GLASS, 0.03);
  side(c, F.pts([[648, 355], [800, 350], [838, 358], [905, 410], [660, 412]]), 0.72, GLASS);

  // White double stripes: hood, roof, deck
  for (const [t, a, b] of [[top, 935, 1266], [cabTop, 589, 832], [top, 335, 440]] as Array<[Fn, number, number]>) {
    const z0 = Math.min(F.z(a), F.z(b)), z1 = Math.max(F.z(a), F.z(b));
    strip(c, t, z0, z1, 0.19, 0.125, WHITE, 0.025);
  }
  bxm(c, 0.88, 0.92, 0.36, 0.6, F.z(610), F.z(740), 0x8f1d20);

  // Chrome bumpers, grille, lamps
  bx(c, -0.88, 0.88, 0.26, 0.4, zNose - 0.02, L / 2, CHROME);
  bx(c, -0.86, 0.86, 0.34, 0.48, zTail, zTail + 0.1, CHROME);
  bx(c, -0.55, 0.55, 0.46, 0.66, zNose - 0.02, zNose + 0.03, 0x1e2230);
  for (const s of [1, -1]) {
    lamp(c, s * 0.75, 0.6, zNose - 0.01, 0.1, 0.05, 0xe4f0f8);
    lamp(c, s * 0.42, 0.6, zNose - 0.01, 0.075, 0.05, 0xe4f0f8);
    bx(c, s * 0.7 - 0.12, s * 0.7 + 0.12, 0.58, 0.7, zTail - 0.02, zTail + 0.02, 0xa8161c);
  }
  chassis(c, [zr, zf], cy, R, HW, base, zTail + 0.15, zNose - 0.1, { hw, top });
  wheels4(c, [zf, zr], HW - 0.15, { r: 0.33, w: 0.26, tyre: 0x23262e, rim: 0xc9ccd2, hub: 0x8d9198 });
};

// ---------------------------------------------------------------------------------------------
// Ford F-150 Raptor
// ---------------------------------------------------------------------------------------------
const raptor: Builder = (c) => {
  const L = 5.6, HW = 0.97, BODY = 0x7a7e85, FLARE = 0x3f4247, GLASS = 0x1f2933, ORANGE = 0xf58a1f, AMBER = 0xffb21e;
  const F = frame(288, 1390, 605, L, false, 1.15);
  const zf = F.z(440), zr = F.z(1100), r = 0.52, R = 0.6, cy = r, base = 0.5;
  const zNose = L / 2 - 0.22, zTail = -L / 2 + 0.12;
  const zBed = F.z(940);
  const floor = 1.2;
  const hood = F.pts([[300, 440], [370, 420], [480, 410], [545, 408], [558, 388], [940, 382]]);
  const top = pl([...hood, [zBed - 0.01, floor], [zTail, floor]]);
  const y0 = pl([[zNose, 0.5], [zNose - 0.2, base], ...arch(zf, cy, R, base), ...arch(zr, cy, R, base), [zTail, base]]);
  const hw = pl([[zNose, 0.9], [zNose - 0.3, HW], [zTail, HW]]);
  loft(c, { z0: zTail, z1: zNose, y0, y1: top, hw, hb: hw, ht: derive(hw, (z) => hw(z) - 0.08), ym: off(top, -0.12), color: BODY });

  // Extended cab
  const cabTop = F.pl([[545, 408], [655, 300], [870, 298], [905, 310], [940, 380]]);
  const cabW = 0.93;
  loft(c, { z0: F.z(940), z1: F.z(545), y0: 1.0, y1: cabTop, hw: cabW, hb: cabW, ht: cabW - 0.08, ym: off(cabTop, -0.1), color: BODY });
  strip(c, cabTop, F.z(652), F.z(550), 0, cabW - 0.07, GLASS, 0.05);
  side(c, F.pts([[590, 368], [612, 335], [656, 308], [750, 306], [750, 368]]), cabW, GLASS);
  side(c, F.pts([[785, 306], [885, 306], [895, 325], [895, 368], [785, 368]]), cabW, GLASS);

  // Bed
  const bedTop = 1.5;
  bxm(c, 0.83, HW, floor, bedTop, zTail, zBed - 0.02, BODY);
  bx(c, -HW, HW, floor, bedTop, zTail, zTail + 0.12, BODY);
  bx(c, -0.83, 0.83, floor, floor + 0.03, zTail + 0.12, zBed - 0.02, 0x2e2f33);

  // Roof light bar with amber markers
  const zb = F.z(660);
  bx(c, -0.62, 0.62, 1.84, 2.0, zb - 0.12, zb + 0.06, 0x16171a);
  for (let i = -2; i <= 2; i++) bx(c, i * 0.22 - 0.06, i * 0.22 + 0.06, 1.9, 1.97, zb + 0.06, zb + 0.1, AMBER);
  bxm(c, 0.55, 0.57, 1.64, 1.84, zb - 0.1, zb - 0.04, 0x16171a);

  // Front: grille, amber lights, headlights, bumper, hooks
  bx(c, -0.62, 0.62, 0.8, 1.12, zNose - 0.03, zNose + 0.02, 0x15161a);
  for (const x of [-0.3, 0, 0.3]) bx(c, x - 0.07, x + 0.07, 1.1, 1.18, zNose, zNose + 0.05, AMBER);
  bxm(c, 0.66, 0.92, 0.9, 1.12, zNose - 0.03, zNose + 0.02, 0x23242a);
  bx(c, -0.95, 0.95, 0.36, 0.78, zNose - 0.1, L / 2, 0x3a3c41);
  bxm(c, 0.45, 0.62, 0.34, 0.5, L / 2 - 0.02, L / 2 + 0.06, ORANGE);
  // Rear: bumper, hooks, tail lights
  bx(c, -0.95, 0.95, 0.4, 0.8, -L / 2, zTail + 0.02, 0x3a3c41);
  bxm(c, 0.45, 0.62, 0.34, 0.5, -L / 2 - 0.06, -L / 2 + 0.02, ORANGE);
  bxm(c, 0.7, 0.93, 1.16, 1.4, zTail - 0.02, zTail + 0.04, 0x4a1b1f);
  // Mirrors and hood vents
  bxm(c, 0.96, 1.14, 1.3, 1.5, F.z(600) - 0.1, F.z(600) + 0.1, ORANGE);
  strip(c, top, F.z(512), F.z(430), 0.46, 0.17, 0x25262a, 0.02);

  // Flares around the big tyres
  for (const [z, ] of [[zf, 0], [zr, 0]] as Array<[number, number]>) {
    const pts: Pt[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI - (Math.PI * i) / 8;
      pts.push([z + (R + 0.1) * Math.cos(a), cy + (R + 0.1) * Math.sin(a) - 0.04]);
    }
    for (let i = 8; i >= 0; i--) {
      const a = Math.PI - (Math.PI * i) / 8;
      pts.push([z + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
    side(c, pts, HW + 0.03, FLARE, 0.16);
  }
  chassis(c, [zf, zr], cy, R, HW, base, zTail + 0.2, zNose - 0.1);
  wheels4(c, [zf, zr], 0.86, { r, w: 0.46, tyre: 0x17181b, rim: 0x44474c, hub: 0x16171a, rimR: 0.58, teeth: 12 });
};

// ---------------------------------------------------------------------------------------------
// Mercedes G-Class
// ---------------------------------------------------------------------------------------------
const gwagon: Builder = (c) => {
  const L = 4.8, HW = 0.97, BODY = 0x33363d, GLASS = 0x151d27, CHROME = 0xb4b8be;
  const F = frame(262, 1030, 613, L, false, 1.1);
  const zf = F.z(387), zr = F.z(840), r = 0.42, R = 0.49, cy = r, base = 0.42;
  const zNose = L / 2 - 0.12, zBack = F.z(970);
  const top = F.pl([[280, 456], [300, 442], [400, 432], [470, 426], [970, 426]]);
  const y0 = pl([[zNose, 0.5], [zNose - 0.2, base], ...arch(zf, cy, R, base), ...arch(zr, cy, R, base), [zBack, 0.5]]);
  const zWs = F.z(470);
  const ht = pl([[zWs + 0.3, 0.7], [zWs, 0.92], [zBack, 0.92]]);
  loft(c, { z0: zBack, z1: zNose, y0, y1: top, hw: HW, hb: HW, ht, ym: off(top, -0.12), color: BODY });

  const cabTop = F.pl([[470, 428], [548, 333], [560, 330], [940, 330], [965, 430]]);
  loft(c, { z0: F.z(965), z1: F.z(470), y0: 1.1, y1: cabTop, hw: 0.92, hb: 0.92, ht: 0.9, ym: off(cabTop, -0.06), color: BODY });
  strip(c, cabTop, F.z(550), F.z(478), 0, 0.84, GLASS, 0.05);
  side(c, F.pts([[518, 421], [544, 349], [646, 349], [646, 421]]), 0.92, GLASS);
  side(c, F.pts([[671, 349], [779, 349], [779, 421], [671, 421]]), 0.92, GLASS);
  side(c, F.pts([[801, 349], [930, 349], [937, 418], [801, 421]]), 0.92, GLASS);

  // Grille, round lights, indicators, bumpers, steps
  bx(c, -0.47, 0.47, 0.62, 0.98, zNose - 0.02, zNose + 0.03, CHROME);
  for (const y of [0.74, 0.86]) bx(c, -0.45, 0.45, y, y + 0.05, zNose + 0.03, zNose + 0.05, 0x17181c);
  for (const s of [1, -1]) {
    lamp(c, s * 0.73, 0.88, zNose, 0.17, 0.04, 0x2a2c31);
    lamp(c, s * 0.73, 0.88, zNose + 0.03, 0.13, 0.04, 0xeef2f4);
    bx(c, s * 0.85 - 0.07, s * 0.85 + 0.07, 1.2, 1.26, zNose - 0.2, zNose - 0.08, 0xe49b2c);
    bx(c, s * 0.8 - 0.07, s * 0.8 + 0.07, 0.86, 0.98, zBack - 0.02, zBack + 0.04, 0xc4161c);
  }
  bx(c, -0.97, 0.97, 0.4, 0.58, zNose - 0.06, L / 2, CHROME);
  bx(c, -0.95, 0.95, 0.34, 0.52, zBack - 0.12, zBack, CHROME);
  bxm(c, 0.97, 1.06, 0.36, 0.44, F.z(920), F.z(480), CHROME);
  bxm(c, 0.95, 1.06, 1.44, 1.62, F.z(515) - 0.08, F.z(515) + 0.08, 0x1e2024);

  // Spare wheel on the tail door
  const sz = F.z(1002);
  const spare = new c.T.CylinderGeometry(0.4, 0.4, 0.34, 12);
  spare.rotateX(Math.PI / 2);
  addMesh(c, spare, 0x1d1e21).position.set(0, 1.1, sz);
  lamp(c, 0, 1.1, sz - 0.17, 0.27, 0.05, 0xa9acb2, -1);

  chassis(c, [zf, zr], cy, R, HW, base, zBack + 0.1, zNose - 0.1);
  wheels4(c, [zf, zr], 0.8, { r, w: 0.3, tyre: 0x1e1f23, rim: 0xa9acb2, hub: 0x55585e, rimR: 0.64, rimSeg: 5 });
};

// ---------------------------------------------------------------------------------------------
// Classic Porsche 911
// ---------------------------------------------------------------------------------------------
const p911: Builder = (c) => {
  const L = 4.3, HW = 0.9, YEL = 0xffd800, GLASS = 0x3a5062, CHROME = 0xd0d3d6;
  const F = frame(273, 1320, 622, L, true);
  const zr = F.z(537), zf = F.z(1105), r = 0.34, R = 0.4, cy = r, base = 0.15;
  const zTail = -L / 2, zNose = L / 2 - 0.05;
  const top = F.pl([[275, 508], [290, 485], [330, 450], [380, 430], [430, 424], [1000, 424], [1100, 440], [1200, 458], [1255, 478], [1295, 500], [1318, 515]]);
  const y0 = pl([[zTail, 0.34], [zTail + 0.2, base], ...arch(zr, cy, R, base), ...arch(zf, cy, R, base), [zNose, 0.17]]);
  const hw = pl([[zTail, 0.84], [zTail + 0.4, HW], [zNose - 0.5, HW], [zNose, 0.84]]);
  const zHood = F.z(1000);
  const ht = pl([[zHood - 0.4, HW - 0.14], [zHood + 0.2, 0.5], [zNose, 0.48]]);
  loft(c, { z0: zTail, z1: zNose, y0, y1: top, hw, hb: derive(hw, (z) => hw(z) - 0.05), ht, mid: 0.6, color: YEL });

  // Fastback cabin
  const cabTop = F.pl([[300, 470], [350, 445], [435, 404], [500, 375], [560, 350], [640, 325], [700, 315], [780, 309], [838, 309], [845, 322], [1000, 420]]);
  const cabW = pl([[F.z(300), 0.5], [F.z(430), 0.72], [F.z(905), 0.72], [F.z(1000), 0.8]]);
  loft(c, { z0: F.z(300), z1: F.z(1000), y0: 0.7, y1: cabTop, hw: cabW, hb: cabW, ht: derive(cabW, (z) => cabW(z) - 0.1), ym: off(cabTop, -0.12), color: YEL });
  const gw = derive(cabW, (z) => cabW(z) - 0.07);
  strip(c, cabTop, F.z(850), F.z(995), 0, gw, GLASS, 0.04);
  side(c, F.pts([[430, 425], [470, 400], [560, 375], [660, 368], [790, 366], [822, 380], [905, 420], [520, 424]]), 0.72, GLASS);
  strip(c, cabTop, F.z(385), F.z(432), 0, 0.28, 0x2a2a2e, 0.03);

  // Frog-eye lamps on the front fenders
  for (const s of [1, -1]) {
    const hump = new c.T.CylinderGeometry(0.2, 0.2, 0.7, 10);
    hump.rotateX(Math.PI / 2);
    addMesh(c, hump, YEL).position.set(s * 0.66, 0.62, zNose - 0.35);
    lamp(c, s * 0.66, 0.62, zNose - 0.01, 0.185, 0.04, 0x1d1d20);
    lamp(c, s * 0.66, 0.62, zNose + 0.02, 0.15, 0.04, 0xe9f2f8);
    bx(c, s * 0.62 - 0.12, s * 0.62 + 0.12, 0.5, 0.62, zTail - 0.02, zTail + 0.02, 0xe56a2a);
  }
  bx(c, -0.84, 0.84, 0.2, 0.32, zNose - 0.12, zNose + 0.04, CHROME);
  bx(c, -0.82, 0.82, 0.3, 0.4, zTail - 0.02, zTail + 0.1, CHROME);

  chassis(c, [zf, zr], cy, R, HW, base, zTail + 0.15, zNose - 0.15, { hw, top });
  wheels4(c, [zf, zr], HW - 0.14, { r, w: 0.26, tyre: 0x1d1d20, rim: 0x8c8f94, hub: 0x2a2a2d, rimR: 0.66, rimSeg: 5 }, { r, w: 0.3, tyre: 0x1d1d20, rim: 0x8c8f94, hub: 0x2a2a2d, rimR: 0.66, rimSeg: 5 });
};

// ---------------------------------------------------------------------------------------------
// Lime wedge supercar
// ---------------------------------------------------------------------------------------------
const supercar: Builder = (c) => {
  const L = 4.6, LIME = 0x95d23b, BLACK = 0x2a2e3e, GLASS = 0x232a36;
  const F = frame(265, 1330, 583, L, true, 1.1);
  const zr = F.z(472), zf = F.z(1076), r = 0.38, R = 0.45, cy = r, base = 0.1;
  const zTail = F.z(272), zNose = L / 2;
  const top = F.pl([[272, 419], [300, 408], [411, 398], [554, 380], [633, 362], [740, 354], [897, 362], [954, 391], [1083, 414], [1133, 426], [1233, 473], [1329, 523]]);
  const y0 = pl([[zTail, 0.45], [zTail + 0.3, 0.16], [zTail + 0.55, base], ...arch(zr, cy, R, base), ...arch(zf, cy, R, base), [zNose, 0.1]]);
  const hw = pl([[zNose, 0.3], [0.9, 0.97], [-0.8, 1.05], [-2.0, 1.03], [zTail, 0.9]]);
  loft(c, { z0: zTail, z1: zNose, y0, y1: top, hw, hb: derive(hw, (z) => hw(z) * 0.8), ht: derive(hw, (z) => hw(z) * 0.78), mid: 0.45, color: LIME });
  strip(c, top, F.z(1100), F.z(905), 0, derive(hw, (z) => hw(z) * 0.62), GLASS, 0.04);
  strip(c, top, F.z(1185), F.z(1140), 0.36, 0.11, 0xeaf6ff, 0.025);
  strip(c, top, F.z(640), F.z(520), 0.4, 0.14, BLACK, 0.03);
  bxm(c, 0.9, 1.05, 0.3, 0.52, F.z(690), F.z(595), BLACK);
  // Splitter, diffuser, rear wing
  bx(c, -0.34, 0.34, 0.04, 0.12, zNose - 0.4, zNose + 0.02, BLACK);
  bx(c, -0.7, 0.7, 0.12, 0.42, zTail - 0.04, zTail + 0.3, BLACK);
  side(c, F.pts([[276, 341], [376, 351], [411, 394], [315, 398]]), 0.97, LIME, 0.07);
  bx(c, -0.97, 0.97, 1.07, 1.13, F.z(376), F.z(285), LIME);
  bxm(c, 0.25, 0.37, 0.82, 1.08, F.z(400), F.z(340), LIME);

  chassis(c, [zf, zr], cy, R, 0.97, base, zTail + 0.3, zNose - 0.55, { hw, top });
  wheels4(c, [zf, zr], 0.88, { r, w: 0.3, tyre: 0x23262f, rim: 0x4b5066, hub: 0x8b90a3, rimR: 0.68, rimSeg: 5 }, { r: 0.4, w: 0.36, tyre: 0x23262f, rim: 0x4b5066, hub: 0x8b90a3, rimR: 0.68, rimSeg: 5 });
};

// ---------------------------------------------------------------------------------------------
// Tesla Cybertruck
// ---------------------------------------------------------------------------------------------
const cybertruck: Builder = (c) => {
  const L = 5.7, STEEL = 0xb9bdc2, DK = 0x2a2c31, GLASS = 0x252b31;
  const F = frame(240, 1345, 617, L, false, 1.2);
  const zf = F.z(405), zr = F.z(1120), r = 0.5, R = 0.6, cy = r, base = 0.3;
  const zNose = L / 2, zTail = -L / 2;
  const top = F.pl([[244, 450], [402, 402], [702, 324], [1344, 400]]);
  const y0 = pl([[zNose, 0.55], [F.z(290), 0.55], [F.z(335), base], ...arch(zf, cy, R, base, 3), ...arch(zr, cy, R, base, 3), [F.z(1300), base], [zTail, 0.55]]);
  const hw = pl([[zNose, 0.85], [zNose - 0.5, 1.03], [zTail, 1.03]]);
  const ym = 0.95, slope = 0.32;
  const ht = derive(top, (z) => hw(z) - Math.max(0, top(z) - ym) * slope);
  loft(c, { z0: zTail, z1: zNose, y0, y1: top, hw, hb: derive(hw, (z) => hw(z) * 0.97), ht, ym, step: 0.3, color: STEEL });

  // Tinted glass skin over the sloped greenhouse
  const yb = 1.22;
  const skinW = derive(top, (z) => hw(z) - (yb - ym) * slope + 0.03);
  loft(c, { z0: F.z(925), z1: F.z(405), y0: yb, y1: off(top, 0.03), hw: skinW, hb: skinW, ht: derive(top, (z) => ht(z) + 0.03), mid: 0, step: 0.3, color: GLASS });

  // Light bars, dark bumpers and sills
  bx(c, -0.8, 0.8, 0.93, 1.02, zNose - 0.02, zNose + 0.03, 0xf3f8ff);
  bx(c, -0.9, 0.9, 1.16, 1.25, zTail - 0.03, zTail + 0.02, 0xff3b30);
  bx(c, -0.78, 0.78, 0.2, 0.55, zNose - 0.3, zNose + 0.05, DK);
  bx(c, -0.98, 0.98, 0.2, 0.55, zTail - 0.05, zTail + 0.32, DK);
  bxm(c, 1.0, 1.06, 0.18, 0.32, F.z(1040), F.z(480), DK);
  for (const px of [530, 740, 935]) bxm(c, 1.02, 1.05, 0.34, 0.95, F.z(px) - 0.035, F.z(px) + 0.035, 0x585b61);
  for (const s of [1, -1]) {
    const arc = new c.T.Mesh(sideGeometry(c.T, [[zf - 0.82, 0.3], [zf - 0.6, 1.04], [zf + 0.6, 1.04], [zf + 0.82, 0.3], [zf + 0.6, 0.3], [zf + 0.4, 0.95], [zf - 0.4, 0.95], [zf - 0.6, 0.3]], 0.05), c.kit.material(DK));
    c.kit.disposables.push(arc.geometry);
    arc.position.x = s * 1.03;
    c.g.add(arc);
  }
  chassis(c, [zf, zr], cy, R, 1.0, base, zTail + 0.3, zNose - 0.3);
  wheels4(c, [zf, zr], 0.86, { r, w: 0.36, tyre: 0x26272b, rim: 0x9a9da3, hub: 0x5c5f66, rimR: 0.78, rimSeg: 8 });
};

// ---------------------------------------------------------------------------------------------
// VW T1 bus with a surfboard
// ---------------------------------------------------------------------------------------------
const vwbus: Builder = (c) => {
  const L = 4.4, HW = 0.89, MINT = 0x5dd8ac, WHITE = 0xf5f5f0, GLASS = 0x6f8c9c, WOOD = 0x7a4f2b, BOARD = 0xb07a45;
  const F = frame(322, 1020, 642, L, false, 1.1);
  const zf = F.z(475), zr = F.z(872), r = 0.33, R = 0.4, cy = r, base = 0.3;
  const belt = 1.09;
  const zFront = F.z(340), zBack = F.z(1008);
  const y0 = pl([[zFront, 0.34], [zFront - 0.12, base], ...arch(zf, cy, R, base), ...arch(zr, cy, R, base), [zBack, base]]);
  const hwL = pl([[zFront, 0.8], [zFront - 0.3, HW - 0.02], [zBack + 0.3, HW - 0.02], [zBack, 0.82]]);
  loft(c, { z0: zBack, z1: zFront, y0, y1: belt, hw: hwL, hb: hwL, ht: hwL, mid: 1, color: MINT });
  // White V on the nose
  const v = new c.T.Mesh(faceGeometry(c.T, [[-0.84, belt], [0.84, belt], [0.1, 0.5], [-0.1, 0.5]], zFront - 0.0, 0.04), c.kit.material(WHITE));
  c.kit.disposables.push(v.geometry);
  v.name = c.name;
  c.g.add(v);

  // Upper cabin: white
  const roof = F.pl([[362, 485], [375, 445], [388, 408], [410, 392], [450, 384], [600, 381], [900, 381], [960, 388], [985, 408], [1000, 450], [1006, 485]]);
  const hwU = pl([[F.z(362), 0.8], [F.z(400), HW], [F.z(960), HW], [F.z(1006), 0.82]]);
  loft(c, { z0: F.z(1006), z1: F.z(362), y0: belt, y1: roof, hw: hwU, hb: hwU, ht: derive(hwU, (z) => hwU(z) - 0.14), ym: off(roof, -0.2), color: WHITE });
  strip(c, roof, F.z(392), F.z(364), 0.41, 0.34, GLASS, 0.08);
  for (const pts of [
    [[412, 470], [432, 420], [530, 420], [530, 470]],
    [[550, 420], [637, 420], [637, 472], [550, 472]],
    [[655, 420], [742, 420], [742, 472], [655, 472]],
    [[760, 420], [845, 420], [845, 472], [760, 472]],
  ] as Pt[][]) side(c, F.pts(pts), HW, GLASS);

  // Round lamps, bumpers, tail lamps
  for (const s of [1, -1]) {
    lamp(c, s * 0.62, 0.78, zFront + 0.04, 0.17, 0.03, 0xcfd2d6);
    lamp(c, s * 0.62, 0.78, zFront + 0.07, 0.13, 0.03, 0xf2f4f5);
    bx(c, s * 0.8 - 0.06, s * 0.8 + 0.06, 0.9, 1.06, zBack - 0.02, zBack + 0.03, 0xb3503f);
  }
  bx(c, -0.93, 0.93, 0.26, 0.46, zFront - 0.12, L / 2, MINT);
  bx(c, -0.93, 0.93, 0.26, 0.46, -L / 2, zBack + 0.1, MINT);

  // Roof rack and surfboard
  const rt = 1.83;
  for (const z of [F.z(667), F.z(830)]) bx(c, -0.82, 0.82, rt, rt + 0.1, z - 0.05, z + 0.05, WOOD);
  bxm(c, 0.6, 0.68, rt, rt + 0.06, -1.55, 1.4, WOOD);
  const board = new c.T.SphereGeometry(1, 10, 6);
  board.scale(0.28, 0.05, 1.55);
  addMesh(c, board, BOARD).position.set(0, rt + 0.15, -0.1);
  const fin = faceGeometry(c.T, [[-0.02, rt + 0.15], [0.02, rt + 0.15], [0.02, rt + 0.34], [-0.02, rt + 0.34]], -1.6, 0.12);
  addMesh(c, fin, 0x8b5a2b);

  chassis(c, [zf, zr], cy, R, HW, base, zBack + 0.1, zFront - 0.1);
  wheels4(c, [zf, zr], HW - 0.14, { r, w: 0.26, tyre: 0x2c2e33, rim: 0xf3f3ee, hub: 0x9ea2a8, rimR: 0.68, rimSeg: 8 });
};

const BUILDERS: Record<CarModel, Builder> = { mustang, raptor, gwagon, p911, supercar, cybertruck, vwbus };

/**
 * One car, centred on the origin, wheels on y = 0, front toward +Z. `userData.wheels` holds the four
 * wheel groups (per side: front, rear); a driving car spins them about x (positive rotation rolls forward).
 */
export function buildCar(kit: PropsKit, model: CarModel): ThreeNS.Group {
  const T = kit.THREE;
  const g = new T.Group();
  g.name = `car-${model}`;
  const ctx: Ctx = { kit, T, g, name: `car-${model}`, wheels: [] };
  BUILDERS[model](ctx);
  g.userData.wheels = ctx.wheels;
  return g;
}
