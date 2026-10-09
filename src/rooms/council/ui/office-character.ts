/**
 * Chibi office people for the council office: a jointed rig (pelvis, spine, neck/head, shoulders with elbows,
 * hips with knees and ankles) built from a few merged, vertex-coloured low-poly parts, and a pose applier that
 * turns an OfficePose into joint angles. One shared vertex-coloured toon material, flat colours, dark outlines.
 *
 * Units are rig units (the caller scales the whole rig). +Z is the front of the character, +Y up, x = right/left.
 * A standing character is about 1.6 tall, a seat top is 0.52 / RIG_SCALE above the floor.
 */
import type * as ThreeNS from "three";
import type { OfficePose } from "./office-behaviour";
import { MESH_EDGE_LINES, getPixelStyle } from "./office-pixel";

type Three = typeof ThreeNS;

export type HairStyle = "short" | "sidePart" | "long" | "bob" | "ponytail" | "curly" | "bun" | "buzz";
export type OutfitKind = "sweater" | "shirtTie" | "jacket" | "hoodie" | "blouseSkirt";

export type CharacterLook = {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  outfit: OutfitKind;
  /** The main garment colour: the seat colour that the name tag also uses (the shirt under a dark jacket for the owner). */
  shirt: string;
  /** Jacket colour for the owner and jackets; for the jacket outfit the jacket is the seat colour and the shirt is `inner`. */
  jacket: string | null;
  inner: string;
  accent: string;
  trousers: string;
  shoes: string;
  glasses: boolean;
  beard: boolean;
  female: boolean;
};

const SKIN_TONES = ["#f6d4b4", "#f2c39b", "#e0b088", "#c68a5e", "#a8714a", "#7a4a2e"];
const HAIR_COLOURS = ["#22201f", "#3a2a22", "#4a3020", "#6b3a1f", "#8a4b24", "#e3b85c", "#b8561f", "#9a9aa3"];
const TROUSER_COLOURS = ["#3a3d4a", "#4a4f5c", "#5b6270", "#2f3a52", "#6a5a48", "#3e4a3e", "#55505a"];
const SKIRT_COLOURS = ["#3a3d4a", "#6a3d4a", "#2f3a52", "#5b4a6a", "#4a4f5c"];
const SHOE_COLOURS = ["#282a36", "#3a2a22", "#4a3426", "#e8e4dc", "#5a3a2a"];
const MALE_HAIR: HairStyle[] = ["short", "sidePart", "short", "curly", "buzz", "sidePart"];
const FEMALE_HAIR: HairStyle[] = ["long", "bob", "ponytail", "bun", "curly", "long", "bob"];

export function hashId(id: string): number {
  let hash = 7;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
  // a final avalanche so near-identical ids (n1, n2) land on different looks
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d) >>> 0;
  hash ^= hash >>> 12;
  hash = Math.imul(hash, 0x297a2d39) >>> 0;
  hash ^= hash >>> 15;
  return hash >>> 0;
}

/** Deterministic look from the actor id; `shirtColor` is the seat colour and stays the main garment colour. */
export function pickCharacterLook(id: string, shirtColor: string): CharacterLook {
  const h = hashId(id);
  const pick = <T,>(list: readonly T[], shift: number): T => list[(h >>> shift) % list.length]!;
  const isOwner = id === "owner";
  const isReception = id === "staff_reception";
  const female = isOwner ? false : isReception ? true : (h & 3) < 2;
  const skin = isOwner ? "#f2c39b" : pick(SKIN_TONES, 3);
  let hair = pick(HAIR_COLOURS, 6);
  let hairStyle: HairStyle = female ? pick(FEMALE_HAIR, 9) : pick(MALE_HAIR, 9);
  if (isOwner) { hair = "#1f1d1d"; hairStyle = "sidePart"; }
  if (isReception) hairStyle = "bob";
  const outfitPool: OutfitKind[] = female
    ? ["sweater", "blouseSkirt", "jacket", "hoodie", "blouseSkirt", "shirtTie"]
    : ["sweater", "shirtTie", "jacket", "hoodie", "sweater", "shirtTie"];
  let outfit = pick(outfitPool, 12);
  if (isOwner) outfit = "jacket";
  if (isReception) outfit = "blouseSkirt";
  const trousers = outfit === "blouseSkirt" ? pick(SKIRT_COLOURS, 15) : pick(TROUSER_COLOURS, 15);
  const ownerJacket = isOwner ? "#2b2e3b" : null;
  return {
    skin,
    hair,
    hairStyle,
    outfit,
    shirt: shirtColor,
    jacket: ownerJacket,
    inner: "#f1ece2",
    accent: shade(shirtColor, 0.6),
    trousers: isOwner ? "#262833" : trousers,
    shoes: isOwner ? "#1c1d26" : pick(SHOE_COLOURS, 18),
    glasses: isOwner ? false : ((h >>> 21) % 5) === 0,
    beard: !female && !isOwner && ((h >>> 24) % 4) === 0,
    female,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Colours

function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function shade(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * f, g * f, b * f);
}
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

// ---------------------------------------------------------------------------------------------------------------
// Low-poly mesher: convex lofted solids and boxes, vertex colours, flat shading, outward winding fixed per face

type Pt = [number, number];
type Ring = { y: number; pts: Pt[] };
type Xf = { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number };

/** A rectangle ring, optionally with chamfered corners (8 points), centred at (ox, oz). */
function rr(w: number, d: number, c = 0, ox = 0, oz = 0): Pt[] {
  const hw = w / 2;
  const hd = d / 2;
  if (c <= 0) return [[-hw + ox, -hd + oz], [hw + ox, -hd + oz], [hw + ox, hd + oz], [-hw + ox, hd + oz]];
  return [
    [-hw + c + ox, -hd + oz], [hw - c + ox, -hd + oz], [hw + ox, -hd + c + oz], [hw + ox, hd - c + oz],
    [hw - c + ox, hd + oz], [-hw + c + ox, hd + oz], [-hw + ox, hd - c + oz], [-hw + ox, -hd + c + oz],
  ];
}

type PartGeo = { main: ThreeNS.BufferGeometry; detail: ThreeNS.BufferGeometry | null };

class Mesher {
  private readonly positions: number[] = [];
  private readonly colours: number[] = [];
  /** Small details (face features, collars, belts): drawn flat, without outlines, so tiny figures stay readable. */
  readonly d: Mesher;
  constructor(private readonly T: Three, withDetail = true) {
    this.d = withDetail ? new Mesher(T, false) : this;
  }

  solid(rings: Ring[], colour: string, xf: Xf = {}): this {
    const T = this.T;
    const c = new T.Color(colour);
    const matrix = new T.Matrix4()
      .makeRotationFromEuler(new T.Euler(xf.rx ?? 0, xf.ry ?? 0, xf.rz ?? 0))
      .setPosition(xf.x ?? 0, xf.y ?? 0, xf.z ?? 0);
    const R = rings.map((r) => r.pts.map(([x, z]) => new T.Vector3(x, r.y, z).applyMatrix4(matrix)));
    const centre = new T.Vector3();
    let count = 0;
    for (const ring of R) for (const p of ring) { centre.add(p); count++; }
    centre.divideScalar(count);
    const ab = new T.Vector3();
    const ac = new T.Vector3();
    const n = new T.Vector3();
    const mid = new T.Vector3();
    const tri = (a: ThreeNS.Vector3, b: ThreeNS.Vector3, d: ThreeNS.Vector3) => {
      ab.subVectors(b, a);
      ac.subVectors(d, a);
      n.crossVectors(ab, ac);
      if (n.lengthSq() < 1e-12) return;
      mid.copy(a).add(b).add(d).divideScalar(3).sub(centre);
      const flip = n.dot(mid) < 0;
      const v = flip ? [a, d, b] : [a, b, d];
      for (const p of v) {
        this.positions.push(p.x, p.y, p.z);
        this.colours.push(c.r, c.g, c.b);
      }
    };
    const k = R[0]!.length;
    for (let i = 0; i < R.length - 1; i++) {
      for (let j = 0; j < k; j++) {
        const j1 = (j + 1) % k;
        tri(R[i]![j]!, R[i]![j1]!, R[i + 1]![j1]!);
        tri(R[i]![j]!, R[i + 1]![j1]!, R[i + 1]![j]!);
      }
    }
    for (const ring of [R[0]!, R[R.length - 1]!]) {
      for (let j = 1; j < k - 1; j++) tri(ring[0]!, ring[j]!, ring[j + 1]!);
    }
    return this;
  }

  /** A box of size w×h×d centred at (cx, cy, cz), optionally rotated about its own centre. */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, colour: string, rot: Pick<Xf, "rx" | "ry" | "rz"> = {}): this {
    return this.solid([{ y: -h / 2, pts: rr(w, d) }, { y: h / 2, pts: rr(w, d) }], colour, { x: cx, y: cy, z: cz, ...rot });
  }

  parts(): PartGeo {
    return { main: this.geometry(), detail: this.d !== this && this.d.positions.length > 0 ? this.d.geometry() : null };
  }

  geometry(): ThreeNS.BufferGeometry {
    const geom = new this.T.BufferGeometry();
    geom.setAttribute("position", new this.T.Float32BufferAttribute(this.positions, 3));
    geom.setAttribute("color", new this.T.Float32BufferAttribute(this.colours, 3));
    geom.computeVertexNormals();
    return geom;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Proportions

const THIGH = 0.32;
const SHIN = 0.35;
const ANKLE = 0.07;
const HIP_STAND = THIGH + SHIN + ANKLE; // 0.74
const UPPER = 0.2;
const FORE = 0.17;
const HAND = 0.1;
const HIP_X = 0.1;
const SHOULDER_X = 0.235;
const SHOULDER_Y = 0.31;
const TORSO_TOP = 0.36;
const NECK_TOP = 0.4; // spine space: where the head's chin sits
const HEAD_H = 0.5;
const EYE_Y = 0.24; // above the chin
/** Seat tops are 0.52 world high and the rig is scaled by 0.88 in the scene. */
const SEAT_TOP = 0.52 / 0.88;
const PELVIS_BOTTOM = -0.09;
const SIT_HIP = SEAT_TOP - PELVIS_BOTTOM - 0.025;
const SIT_FLEX = 1.31; // thighs a little under horizontal
const SIT_KNEE = SIT_FLEX; // shins vertical
const SIT_SHIN_SCALE = Math.min(1.6, (SIT_HIP - THIGH * Math.cos(SIT_FLEX) - ANKLE) / SHIN);
const SIT_Z = -0.02;

/** Half depth of the torso at a height (for pinning details on its front). */
function torsoHalfDepth(y: number): number {
  const pts: Array<[number, number]> = [[-0.05, 0.105], [0.09, 0.1], [TORSO_TOP - 0.1, 0.125], [TORSO_TOP - 0.03, 0.12]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [y0, d0] = pts[i]!;
    const [y1, d1] = pts[i + 1]!;
    if (y <= y1) return d0 + ((d1 - d0) * (Math.max(y, y0) - y0)) / (y1 - y0);
  }
  return 0.12;
}
/** Front of the head skin at a height above the chin. */
function headFront(y: number): number {
  if (y <= 0.09) return 0.17 + ((0.23 - 0.17) * y) / 0.09;
  if (y <= 0.4) return 0.23 + (0.005 * (y - 0.09)) / 0.31;
  return 0.235 - ((y - 0.4) * 0.03) / 0.1;
}

// ---------------------------------------------------------------------------------------------------------------
// Parts

function buildHead(look: CharacterLook, T: Three): { head: PartGeo; eyes: ThreeNS.BufferGeometry } {
  const m = new Mesher(T);
  const skin = look.skin;
  const hair = look.hair;
    const hairDark = shade(hair, 0.8);
  m.solid([
    { y: 0, pts: rr(0.4, 0.34, 0.08) },
    { y: 0.09, pts: rr(0.52, 0.44, 0.09) },
    { y: 0.4, pts: rr(0.56, 0.48, 0.1) },
    { y: HEAD_H, pts: rr(0.5, 0.42, 0.11) },
  ], skin);
  const ey = EYE_Y;
  // ears, nose, blush, mouth
  for (const s of [-1, 1]) {
    m.d.box(s * 0.285, ey - 0.02, 0, 0.04, 0.1, 0.08, shade(skin, 0.95));
    m.d.box(s * 0.17, ey - 0.085, headFront(ey - 0.085) + 0.004, 0.07, 0.035, 0.012, mix(skin, "#ff6f86", 0.38));
  }
  m.d.box(0, ey - 0.06, headFront(ey - 0.06) + 0.013, 0.05, 0.05, 0.034, shade(skin, 0.9));
  const mouthY = look.beard ? 0.12 : 0.1;
  m.d.box(0, mouthY, headFront(mouthY) + 0.004, 0.08, 0.022, 0.012, "#9c4a4a");
  for (const s of [-1, 1]) m.d.box(s * 0.046, mouthY + 0.014, headFront(mouthY) + 0.004, 0.02, 0.02, 0.012, "#9c4a4a");
  // brows
  for (const s of [-1, 1]) {
    m.d.box(s * 0.14, ey + 0.115, headFront(ey + 0.1) + 0.006, 0.115, 0.028, 0.014, shade(hair, 0.85), { rz: s * 0.1 });
  }

  // hair
  const hz = (y: number) => headFront(y) + 0.004;
  const cap = (top = 0.59) => m.solid([
    { y: 0.3, pts: rr(0.58, 0.46, 0.09, 0, -0.05) },
    { y: 0.42, pts: rr(0.6, 0.48, 0.12, 0, -0.05) },
    { y: 0.53, pts: rr(0.56, 0.45, 0.15, 0, -0.045) },
    { y: top - 0.01, pts: rr(0.42, 0.34, 0.13, 0, -0.04) },
  ], hair);
  const fringe = (w: number, y0: number, x = 0) => m.box(x, (y0 + 0.515) / 2, hz(0.45) - 0.004, w, 0.515 - y0, 0.026, hair);
  const sideburns = (bottom: number) => {
    for (const s of [-1, 1]) m.box(s * 0.288, (bottom + 0.34) / 2, -0.08, 0.04, 0.34 - bottom, 0.28, hair);
  };
  const nape = () => m.d.box(0, 0.3, -0.245, 0.54, 0.34, 0.06, hairDark);
  switch (look.hairStyle) {
    case "short": {
      cap();
      fringe(0.55, 0.42);
      for (const [x, y0, w] of [[-0.19, 0.385, 0.12], [0.03, 0.4, 0.1], [0.2, 0.385, 0.12]] as const) {
        m.d.box(x, (y0 + 0.43) / 2, hz(0.42) + 0.014, w, 0.43 - y0, 0.03, hair);
      }
      sideburns(0.25);
      nape();
      break;
    }
    case "sidePart": {
      cap();
      fringe(0.55, 0.43);
      m.d.box(-0.1, 0.4, hz(0.42) + 0.012, 0.34, 0.08, 0.036, hair, { rz: -0.1 });
      m.d.box(0.2, 0.43, hz(0.43) + 0.014, 0.12, 0.05, 0.03, hairDark);
      m.d.box(0.13, 0.575, 0, 0.016, 0.04, 0.32, hairDark);
      sideburns(0.25);
      nape();
      break;
    }
    case "buzz": {
      m.solid([
        { y: 0.32, pts: rr(0.575, 0.505, 0.09, 0, -0.03) },
        { y: 0.5, pts: rr(0.575, 0.505, 0.1, 0, -0.03) },
        { y: 0.55, pts: rr(0.48, 0.42, 0.12, 0, -0.03) },
      ], shade(hair, 0.9));
      m.d.box(0, 0.475, headFront(0.47) + 0.012, 0.46, 0.05, 0.022, shade(hair, 0.9));
      sideburns(0.28);
      break;
    }
    case "long": {
      cap();
      for (const s of [-1, 1]) {
        m.box(s * 0.12, 0.45, hz(0.45), 0.32, 0.13, 0.04, hair, { rz: -s * 0.2 });
        m.box(s * 0.3, 0.17, -0.03, 0.07, 0.46, 0.38, hair);
      }
      m.solid([{ y: -0.14, pts: rr(0.4, 0.1, 0.04, 0, -0.27) }, { y: 0.05, pts: rr(0.5, 0.12, 0.05, 0, -0.275) }, { y: 0.4, pts: rr(0.6, 0.13, 0.05, 0, -0.265) }, { y: 0.52, pts: rr(0.54, 0.12, 0.05, 0, -0.25) }], hair);
      break;
    }
    case "bob": {
      cap();
      m.box(0, 0.44, hz(0.44), 0.58, 0.12, 0.045, hair);
      for (const s of [-1, 1]) m.box(s * 0.3, 0.25, -0.02, 0.07, 0.4, 0.41, hair);
      m.solid([{ y: 0.04, pts: rr(0.44, 0.1, 0.04, 0, -0.265) }, { y: 0.2, pts: rr(0.56, 0.12, 0.05, 0, -0.27) }, { y: 0.44, pts: rr(0.6, 0.13, 0.05, 0, -0.265) }, { y: 0.52, pts: rr(0.54, 0.12, 0.05, 0, -0.25) }], hair);
      break;
    }
    case "ponytail": {
      cap();
      fringe(0.55, 0.42);
      m.box(0.1, 0.405, hz(0.41) + 0.012, 0.3, 0.08, 0.03, hair, { rz: 0.1 });
      sideburns(0.25);
      nape();
      m.d.box(0, 0.42, -0.3, 0.09, 0.09, 0.07, look.accent);
      m.box(0, 0.24, -0.4, 0.15, 0.32, 0.11, hair, { rx: 0.35 });
      break;
    }
    case "curly": {
      m.solid([
        { y: 0.26, pts: rr(0.64, 0.58, 0.12, 0, -0.045) },
        { y: 0.46, pts: rr(0.7, 0.64, 0.16, 0, -0.045) },
        { y: 0.6, pts: rr(0.6, 0.54, 0.16, 0, -0.045) },
        { y: 0.67, pts: rr(0.44, 0.4, 0.12, 0, -0.045) },
      ], hair);
      for (const [x, z] of [[-0.33, 0.1], [0.33, 0.1], [-0.33, -0.2], [0.33, -0.2], [0, -0.34]] as const) {
        m.box(x, 0.43, z, 0.13, 0.16, 0.13, hair, { ry: 0.5 });
      }
      m.box(0, 0.45, hz(0.45) - 0.002, 0.5, 0.1, 0.04, hair);
      break;
    }
    case "bun": {
      cap();
      m.box(0, 0.44, hz(0.44), 0.56, 0.11, 0.04, hair);
      m.box(-0.12, 0.4, hz(0.4) + 0.012, 0.22, 0.06, 0.03, hair, { rz: -0.2 });
      sideburns(0.22);
      nape();
      m.box(0, 0.7, -0.1, 0.22, 0.19, 0.22, hair, { ry: 0.4 });
      m.d.box(0, 0.61, -0.1, 0.24, 0.03, 0.24, look.accent);
      break;
    }
  }

  if (look.glasses) {
    const frame = "#2b2d3a";
    const z = headFront(ey) + 0.014;
    for (const s of [-1, 1]) {
      const cx = s * 0.13;
      m.d.box(cx, ey + 0.07, z, 0.165, 0.02, 0.016, frame);
      m.d.box(cx, ey - 0.07, z, 0.165, 0.02, 0.016, frame);
      m.d.box(cx - 0.073, ey, z, 0.02, 0.14, 0.016, frame);
      m.d.box(cx + 0.073, ey, z, 0.02, 0.14, 0.016, frame);
      m.d.box(s * 0.285, ey + 0.03, 0.0, 0.016, 0.02, 0.44, frame);
    }
    m.d.box(0, ey + 0.03, z, 0.06, 0.018, 0.016, frame);
  }
  if (look.beard) {
    m.box(0, 0.04, headFront(0.04) + 0.014, 0.4, 0.1, 0.04, hair);
    for (const s of [-1, 1]) m.box(s * 0.245, 0.14, 0.0, 0.05, 0.26, 0.34, hair);
    m.d.box(0, 0.14, headFront(0.14) + 0.01, 0.1, 0.022, 0.014, hair);
  }

  // eyes: one mesh centred on the eye line, scaled in y to blink
  const e = new Mesher(T);
  const ez = headFront(ey) + 0.006;
  for (const s of [-1, 1]) {
    e.box(s * 0.14, 0, ez, 0.085, 0.135, 0.02, "#121218");
    e.box(s * 0.14 + 0.017, 0.032, ez + 0.012, 0.034, 0.042, 0.01, "#ffffff");
    e.box(s * 0.14 - 0.02, -0.036, ez + 0.012, 0.018, 0.02, 0.01, "#ffffff");
  }
  return { head: m.parts(), eyes: e.geometry() };
}

function torsoGeometry(look: CharacterLook, T: Three): PartGeo {
  const m = new Mesher(T);
  const skin = look.skin;
  const outfit = look.outfit;
  // the garment that shows from outside; for the owner that is the dark jacket over the shirt
  const outer = look.jacket ?? look.shirt;
  const hasJacket = outfit === "jacket";
  const shirtColour = look.jacket ? look.shirt : look.inner;
  const TOP = TORSO_TOP;
  const body = [
    { y: -0.05, pts: rr(0.32, 0.21, 0.05) },
    { y: 0.09, pts: rr(0.31, 0.2, 0.05) },
    { y: TOP - 0.1, pts: rr(0.41, 0.25, 0.07) },
    { y: TOP - 0.03, pts: rr(0.42, 0.24, 0.08) },
    { y: TOP, pts: rr(0.3, 0.2, 0.07) },
  ];
  m.d.box(0, TOP + 0.015, 0, 0.13, 0.11, 0.12, shade(skin, 0.97));
  const collarY = TOP - 0.005;
  if (hasJacket) {
    // shirt body under the jacket, then the jacket slightly bigger
    m.solid(body, shirtColour);
    const jk = body.map((r) => ({ y: r.y === -0.05 ? -0.08 : r.y, pts: r.pts.map(([x, z]) => [x * 1.07, z * 1.1] as Pt) }));
    m.solid(jk, outer);
    const open = look.jacket ? 0.17 : 0.1;
    const cy = (TOP - 0.02) / 2;
    m.d.box(0, cy, torsoHalfDepth(cy) * 1.1 + 0.002, open, TOP - 0.04, 0.026, shirtColour);
    for (const s of [-1, 1]) m.d.box(s * (open / 2 + 0.03), cy + 0.04, torsoHalfDepth(cy) * 1.1 + 0.012, 0.06, TOP - 0.1, 0.026, shade(outer, 0.8), { rz: s * 0.1 });
    if (look.jacket) m.d.box(0, 0.1, torsoHalfDepth(0.1) * 1.1 + 0.012, 0.1, 0.07, 0.02, shade(look.shirt, 0.8));
    for (const s of [-1, 1]) m.d.box(s * 0.065, collarY, 0.075, 0.08, 0.05, 0.07, shirtColour, { rz: s * 0.45 });
    if (!look.jacket) m.d.box(0, cy, torsoHalfDepth(cy) * 1.1 + 0.01, 0.04, 0.26, 0.018, look.accent);
  } else {
    m.solid(body, outer);
    switch (outfit) {
      case "sweater":
        for (const s of [-1, 1]) m.d.box(s * 0.07, collarY, 0.07, 0.09, 0.05, 0.08, "#f6f3ec", { rz: s * 0.5 });
        m.d.box(0, collarY + 0.005, -0.065, 0.2, 0.04, 0.05, "#f6f3ec");
        break;
      case "shirtTie":
        for (const s of [-1, 1]) m.d.box(s * 0.065, collarY, 0.075, 0.08, 0.05, 0.07, mix(outer, "#ffffff", 0.7), { rz: s * 0.45 });
        m.d.box(0, collarY - 0.005, 0.055, 0.1, 0.03, 0.06, mix(outer, "#ffffff", 0.7));
        m.d.box(0, TOP - 0.15, torsoHalfDepth(TOP - 0.15) + 0.004, 0.05, 0.26, 0.018, look.accent);
        m.d.box(0, TOP - 0.03, torsoHalfDepth(TOP - 0.03) + 0.006, 0.065, 0.04, 0.03, shade(look.accent, 1.15));
        m.d.box(0, 0.015, 0, 0.325, 0.035, 0.215, "#2b2e3b");
        break;
      case "hoodie":
        m.d.box(0, TOP - 0.01, -0.085, 0.3, 0.1, 0.13, shade(outer, 0.88));
        m.d.box(0, TOP - 0.008, 0.035, 0.2, 0.05, 0.1, shade(outer, 0.88));
        m.d.box(0, 0.06, torsoHalfDepth(0.06) + 0.004, 0.23, 0.1, 0.02, shade(outer, 0.85));
        for (const s of [-1, 1]) m.d.box(s * 0.05, TOP - 0.1, torsoHalfDepth(TOP - 0.1) + 0.008, 0.014, 0.13, 0.014, "#f6f3ec");
        break;
      case "blouseSkirt":
        for (const s of [-1, 1]) m.d.box(s * 0.07, collarY, 0.07, 0.085, 0.05, 0.075, mix(outer, "#ffffff", 0.55), { rz: s * 0.5 });
        m.d.box(0, TOP - 0.05, torsoHalfDepth(TOP - 0.05) + 0.01, 0.07, 0.05, 0.03, shade(look.accent, 1.3));
        break;
      default:
        break;
    }
  }
  return m.parts();
}

function pelvisGeometry(look: CharacterLook, T: Three): PartGeo {
  const m = new Mesher(T);
  if (look.outfit === "blouseSkirt") {
    m.solid([
      { y: 0.07, pts: rr(0.33, 0.22, 0.05) },
      { y: 0.0, pts: rr(0.36, 0.25, 0.06) },
      { y: -0.13, pts: rr(0.46, 0.37, 0.08) },
    ], look.trousers);
    m.d.box(0, 0.075, 0, 0.335, 0.03, 0.225, shade(look.trousers, 0.7));
  } else {
    m.solid([
      { y: PELVIS_BOTTOM, pts: rr(0.33, 0.21, 0.05) },
      { y: 0.07, pts: rr(0.335, 0.215, 0.05) },
    ], look.trousers);
    m.d.box(0, 0.06, 0, 0.34, 0.035, 0.22, shade(look.trousers, 0.7));
  }
  return m.parts();
}

function upperArmGeometry(look: CharacterLook, T: Three): PartGeo {
  const sleeve = look.jacket ?? look.shirt;
  const m = new Mesher(T);
  m.solid([{ y: 0.05, pts: rr(0.13, 0.13, 0.03) }, { y: 0.0, pts: rr(0.145, 0.14, 0.03) }, { y: -UPPER, pts: rr(0.115, 0.115, 0.025) }], sleeve);
  return m.parts();
}

function forearmGeometry(look: CharacterLook, side: number, T: Three): PartGeo {
  const m = new Mesher(T);
  const sleeve = look.jacket ?? look.shirt;
  const bareFrom = look.outfit === "blouseSkirt" ? 0.07 : FORE;
  m.solid([{ y: 0.0, pts: rr(0.115, 0.115, 0.025) }, { y: -bareFrom, pts: rr(0.1, 0.1, 0.025) }], sleeve);
  if (bareFrom < FORE) m.solid([{ y: -bareFrom + 0.004, pts: rr(0.09, 0.09, 0.02) }, { y: -FORE, pts: rr(0.085, 0.085, 0.02) }], look.skin);
  else if (look.jacket || look.outfit === "jacket") m.d.box(0, -FORE + 0.012, 0, 0.108, 0.026, 0.108, look.jacket ? look.shirt : look.inner);
  else if (look.outfit === "hoodie" || look.outfit === "sweater") m.d.box(0, -FORE + 0.014, 0, 0.108, 0.03, 0.108, shade(sleeve, 0.85));
  m.solid([{ y: -FORE + 0.002, pts: rr(0.085, 0.075, 0.02) }, { y: -FORE - HAND * 0.45, pts: rr(0.1, 0.08, 0.02) }, { y: -FORE - HAND, pts: rr(0.085, 0.07, 0.02) }], look.skin);
  m.d.box(-side * 0.055, -FORE - 0.04, 0.012, 0.032, 0.06, 0.04, shade(look.skin, 0.95), { rz: side * 0.15 });
  return m.parts();
}

function thighGeometry(look: CharacterLook, T: Three): PartGeo {
  const m = new Mesher(T);
  m.solid([{ y: 0.06, pts: rr(0.165, 0.175, 0.035) }, { y: -THIGH * 0.5, pts: rr(0.15, 0.16, 0.035) }, { y: -THIGH, pts: rr(0.125, 0.135, 0.03) }], look.trousers);
  return m.parts();
}

function shinGeometry(look: CharacterLook, T: Three): PartGeo {
  const m = new Mesher(T);
  const legColour = look.outfit === "blouseSkirt" ? mix(look.skin, look.trousers, 0.1) : look.trousers;
  m.solid([{ y: 0.0, pts: rr(0.125, 0.135, 0.03) }, { y: -SHIN, pts: rr(0.1, 0.11, 0.025) }], legColour);
  return m.parts();
}

function shoeGeometry(look: CharacterLook, T: Three): PartGeo {
  const m = new Mesher(T);
  const sole = shade(look.shoes, 0.55);
  const top = look.shoes;
  // origin at the ankle joint: the sole is 0.07 below it
  m.solid([{ y: -ANKLE, pts: rr(0.125, 0.3, 0.035, 0, 0.06) }, { y: -ANKLE + 0.03, pts: rr(0.127, 0.302, 0.035, 0, 0.06) }], sole);
  m.solid([{ y: -ANKLE + 0.03, pts: rr(0.12, 0.29, 0.04, 0, 0.06) }, { y: 0.02, pts: rr(0.11, 0.26, 0.04, 0, 0.04) }, { y: 0.05, pts: rr(0.1, 0.12, 0.03, 0, -0.02) }], top);
  return m.parts();
}

function mugGeometry(T: Three): PartGeo {
  const m = new Mesher(T);
  m.box(0, 0, 0, 0.075, 0.09, 0.075, "#f4efe6");
  m.box(0, 0.046, 0, 0.06, 0.012, 0.06, "#5a3a26");
  m.box(0.05, 0, 0, 0.03, 0.06, 0.02, "#f4efe6");
  m.box(0, -0.01, 0, 0.078, 0.025, 0.078, "#c9553f");
  return m.parts();
}

// ---------------------------------------------------------------------------------------------------------------
// Rig

type Arm = { shoulder: ThreeNS.Group; elbow: ThreeNS.Group };
type Leg = { hip: ThreeNS.Group; knee: ThreeNS.Group; ankle: ThreeNS.Group; shin: ThreeNS.Mesh };

export type CharacterModel = {
  root: ThreeNS.Group;
  look: CharacterLook;
  pelvis: ThreeNS.Group;
  spine: ThreeNS.Group;
  /** The head pivot (yaw it from outside for looking at someone; the pose applier sets pitch and yaw each frame). */
  headGroup: ThreeNS.Group;
  eyes: ThreeNS.Mesh;
  mug: ThreeNS.Mesh;
  arms: [Arm, Arm];
  legs: [Leg, Leg];
  /** Height of the head centre in rig units, updated by `applyCharacterPose` (for name tags). */
  headY: number;
  meshCount: number;
};

export type CharacterKit = {
  THREE: Three;
  outlineMaterial: ThreeNS.LineBasicMaterial;
  disposables: Array<{ dispose: () => void }>;
};

/** One shared vertex-coloured toon material for every person (flat colours, no textures). */
const materialCache = new WeakMap<object, ThreeNS.MeshToonMaterial>();
function sharedMaterial(kit: CharacterKit): ThreeNS.MeshToonMaterial {
  let mat = materialCache.get(kit.disposables);
  if (!mat) {
    mat = getPixelStyle(kit.THREE).toon({ vertexColors: true });
    kit.disposables.push(mat);
    materialCache.set(kit.disposables, mat);
  }
  return mat;
}

export function buildCharacter(kit: CharacterKit, look: CharacterLook): CharacterModel {
  const T = kit.THREE;
  const material = sharedMaterial(kit);
  let meshCount = 0;
  const makeMesh = (part: PartGeo | ThreeNS.BufferGeometry, outlined = true): ThreeNS.Mesh => {
    const { main, detail } = "main" in part ? part : { main: part, detail: null };
    kit.disposables.push(main);
    const mesh = new T.Mesh(main, material);
    if (outlined && MESH_EDGE_LINES) {
      const edges = new T.EdgesGeometry(main, 30);
      kit.disposables.push(edges);
      mesh.add(new T.LineSegments(edges, kit.outlineMaterial));
    }
    if (detail) {
      kit.disposables.push(detail);
      mesh.add(new T.Mesh(detail, material));
    }
    meshCount++;
    return mesh;
  };
  const group = (x = 0, y = 0, z = 0) => {
    const g = new T.Group();
    g.position.set(x, y, z);
    return g;
  };

  const root = new T.Group();
  const pelvis = group(0, HIP_STAND, 0);
  root.add(pelvis);
  pelvis.add(makeMesh(pelvisGeometry(look, T)));

  const spine = group(0, 0, 0);
  pelvis.add(spine);
  spine.add(makeMesh(torsoGeometry(look, T)));

  const headGroup = group(0, NECK_TOP, 0);
  spine.add(headGroup);
  const headParts = buildHead(look, T);
  headGroup.add(makeMesh(headParts.head));
  const eyes = makeMesh(headParts.eyes, false);
  eyes.position.y = EYE_Y;
  headGroup.add(eyes);

  const buildArm = (side: number): Arm => {
    const shoulder = group(side * SHOULDER_X, SHOULDER_Y, 0);
    shoulder.add(makeMesh(upperArmGeometry(look, T)));
    const elbow = group(0, -UPPER, 0);
    shoulder.add(elbow);
    elbow.add(makeMesh(forearmGeometry(look, side, T)));
    spine.add(shoulder);
    return { shoulder, elbow };
  };
  const arms: [Arm, Arm] = [buildArm(-1), buildArm(1)];

  const mug = makeMesh(mugGeometry(T));
  mug.position.set(0, -FORE - 0.05, 0.035);
  mug.visible = false;
  arms[1].elbow.add(mug);

  const buildLeg = (side: number): Leg => {
    const hip = group(side * HIP_X, 0, 0);
    hip.add(makeMesh(thighGeometry(look, T)));
    const knee = group(0, -THIGH, 0);
    hip.add(knee);
    const shin = makeMesh(shinGeometry(look, T));
    knee.add(shin);
    const ankle = group(0, -SHIN, 0);
    knee.add(ankle);
    ankle.add(makeMesh(shoeGeometry(look, T)));
    pelvis.add(hip);
    return { hip, knee, ankle, shin };
  };
  const legs: [Leg, Leg] = [buildLeg(-1), buildLeg(1)];

  return {
    root, look, pelvis, spine, headGroup, eyes, mug, arms, legs,
    headY: HIP_STAND + NECK_TOP + HEAD_H / 2, meshCount,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pose

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Applies an OfficePose to the rig's joints. `timeSec` drives blinking; `blink` may be forced by the caller.
 * Existing OfficePose fields keep their meaning (arm pitch negative = forward); legs use `sitAmount` for the seat.
 */
export function applyCharacterPose(model: CharacterModel, pose: OfficePose, timeSec: number): void {
  const s = Math.max(0, Math.min(1, pose.sitAmount));
  const lean = pose.torsoLean;

  // Hips: the walking swing is (1 - s) of the leg pitch (positive = back); sitting flexes the thighs to a slightly sloping seat
  const legPitches = [pose.leftLegPitch, pose.rightLegPitch];
  const kneeRaw = [pose.leftKnee, pose.rightKnee];
  const flexes: number[] = [];
  const knees: number[] = [];
  let contact = 0;
  for (let i = 0; i < 2; i++) {
    const walkFlex = -(legPitches[i]! - s * (Math.PI / 2));
    const flex = walkFlex + s * SIT_FLEX;
    const knee = kneeRaw[i]! * (1 - s) + SIT_KNEE * s;
    flexes.push(flex);
    knees.push(knee);
    const shinLen = SHIN * lerp(1, SIT_SHIN_SCALE, s);
    contact = Math.max(contact, THIGH * Math.cos(flex) + shinLen * Math.cos(flex - knee));
  }
  const bob = pose.bodyY - lerp(0.88, 0.7, s);
  model.pelvis.position.y = lerp(ANKLE + contact, SIT_HIP, s) + bob;
  model.pelvis.position.z = SIT_Z * s;
  model.pelvis.rotation.x = 0;
  model.pelvis.rotation.y = -pose.spineYaw * 0.4;

  const shinScale = lerp(1, SIT_SHIN_SCALE, s);
  model.legs.forEach((leg, i) => {
    const flex = flexes[i]!;
    const knee = knees[i]!;
    leg.hip.rotation.x = -flex;
    leg.hip.rotation.z = (i === 0 ? 1 : -1) * 0.04 * s;
    leg.knee.rotation.x = knee;
    leg.shin.scale.y = shinScale;
    leg.ankle.position.y = -SHIN * shinScale;
    leg.ankle.rotation.x = (flex - knee) * 0.85;
  });

  model.spine.rotation.x = lean;
  model.spine.rotation.y = pose.spineYaw;

  const armValues: Array<[number, number, number, number, number]> = [
    [pose.leftArmPitch, pose.leftArmYaw, pose.leftArmRoll, pose.leftElbow, 0],
    [pose.rightArmPitch, pose.rightArmYaw, pose.rightArmRoll, pose.rightElbow, 1],
  ];
  for (const [pitch, yaw, roll, elbow, idx] of armValues) {
    const arm = model.arms[idx]!;
    arm.shoulder.rotation.set(pitch, yaw, roll);
    arm.elbow.rotation.x = -elbow;
  }
  model.mug.visible = pose.cup > 0.01;
  if (model.mug.visible) model.mug.rotation.x = pose.rightElbow - pose.rightArmPitch - lean;

  model.headGroup.rotation.x = pose.headPitch - lean * 0.6;
  model.headGroup.rotation.y = pose.headYaw;

  const blink = (Math.floor(timeSec * 3) % 11) === 0;
  model.eyes.scale.y = blink ? 0.15 : 1;

  model.headY = model.pelvis.position.y + Math.cos(lean) * (NECK_TOP + HEAD_H / 2);
}

/** Dimensions for harness and tests. */
export const CHARACTER_DIMENSIONS = { standingHeight: HIP_STAND + NECK_TOP + HEAD_H, hipStand: HIP_STAND, sitHip: SIT_HIP, sitShinScale: SIT_SHIN_SCALE };
