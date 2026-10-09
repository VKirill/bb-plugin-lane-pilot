/**
 * Rigged chibi people for the council office (assets/office-people.glb, embedded as base64 because the plugin
 * bundles into one app.js). Eight characters, one skeleton layout, ten shared clips. The procedural rig in
 * office-character.ts stays as the fallback while this loads or if it cannot.
 *
 * The pure helpers (variant choice, clip choice, seat placement) have no three.js dependency and are unit tested.
 */
import type * as ThreeNS from "three";
import { OWNER_SEAT_ID, RECEPTIONIST_ID } from "./office-behaviour";
import { hashId } from "./office-character";
import { getPixelStyle } from "./office-pixel";

type Three = typeof ThreeNS;

export const PERSON_VARIANTS = 8;
export const OWNER_VARIANT = 0;
export const RECEPTIONIST_VARIANT = 5;
/** Height of a person in world units (the GLB is 1.40 m; a little taller reads better in 16 px per unit). */
export const PERSON_SCALE = 1.25;
/** Crossfade between clips, seconds. */
export const CLIP_FADE = 0.25;

export type PersonClip =
  | "Idle" | "Walk" | "Talk" | "Sit" | "SitTalk" | "Interact" | "SitType" | "Drink" | "Point" | "Window";

/** Length of the Walk clip in seconds (one cycle is two steps). */
export const WALK_CLIP_SECONDS = 1.33;
/** Ground covered by one Walk cycle of the unscaled model, metres; measured from the foot travel of the clip. */
export const WALK_STRIDE = 1.05;

/**
 * The variant of a person: the owner and the receptionist keep their own characters, everyone else takes the
 * variant the floor uses least, starting the probe at a stable hash of the id (repeats only once all are in use).
 * `others` holds the variants of the other people on the floor.
 */
export function pickPersonVariant(id: string, others: readonly number[]): number {
  if (id === OWNER_SEAT_ID) return OWNER_VARIANT;
  if (id === RECEPTIONIST_ID) return RECEPTIONIST_VARIANT;
  const counts = new Array<number>(PERSON_VARIANTS).fill(0);
  counts[OWNER_VARIANT] = 1;
  counts[RECEPTIONIST_VARIANT] = 1;
  for (const v of others) if (v >= 0 && v < PERSON_VARIANTS) counts[v]! += 1;
  // the owner and the receptionist are counted once already; do not count them twice when they are among `others`
  if (others.includes(OWNER_VARIANT)) counts[OWNER_VARIANT]! -= 1;
  if (others.includes(RECEPTIONIST_VARIANT)) counts[RECEPTIONIST_VARIANT]! -= 1;
  const start = hashId(id) % PERSON_VARIANTS;
  let best = start;
  for (let i = 0; i < PERSON_VARIANTS; i++) {
    const v = (start + i) % PERSON_VARIANTS;
    if (counts[v]! < counts[best]!) best = v;
  }
  return best;
}

export type PersonState = {
  walking: boolean;
  /** Seated (the transition is done by the seat lift; the clip follows the target at once). */
  sitting: boolean;
  activity: string;
  action?: string;
  /** Slow counter that swaps a seated listener between Sit and SitTalk now and then. */
  slot?: number;
};

/** The clip a person plays for what the simulation says it is doing. */
export function clipForState(s: PersonState): PersonClip {
  if (s.walking) return "Walk";
  if (s.sitting) {
    if (s.action === "typing") return "SitType";
    if (s.activity === "waiting" && (s.slot ?? 1) % 4 === 0) return "SitTalk";
    return "Sit";
  }
  if (s.activity === "arguing") return "Point";
  if (s.activity === "speaking") return "Talk";
  switch (s.action) {
    case "chat": return "Talk";
    case "coffee":
    case "bar": return "Drink";
    case "operate": return "Interact";
    case "window": return "Window";
    default: return "Idle";
  }
}

/** Time scale of the Walk clip so the feet keep up with the ground speed (world units per second). */
export function walkTimeScale(speed: number, scale: number = PERSON_SCALE): number {
  return speed / ((WALK_STRIDE * scale) / WALK_CLIP_SECONDS);
}

/** Seat top heights of the furniture in office-scene.ts. */
export const SEAT_HEIGHT_CHAIR = 0.52;
export const SEAT_HEIGHT_SOFA = 0.5;
export const SEAT_HEIGHT_STOOL = 0.7;

export function seatHeightForPoint(pointId: string | undefined, kind: string | undefined): number {
  if (pointId?.startsWith("pt_stool")) return SEAT_HEIGHT_STOOL;
  if (kind === "sofa") return SEAT_HEIGHT_SOFA;
  return SEAT_HEIGHT_CHAIR;
}

/** Lowest point of the seated pelvis and thighs per character (model units, y up), from office-people.md. */
const SEAT_CONTACT = [0.104, 0.188, 0.173, 0.174, 0.159, 0.187, 0.171, 0.114] as const;
/** The seated pelvis sits behind the feet; the body moves this far forward (model units) to sit over the seat centre. */
const SEAT_FORWARD = 0.18;

/** Offset of a fully seated person from the standing spot: y puts the pelvis on the seat, z moves it over the seat. */
export function seatPlacement(variant: number, seatHeight: number, scale: number = PERSON_SCALE): { y: number; z: number } {
  const contact = SEAT_CONTACT[Math.max(0, Math.min(PERSON_VARIANTS - 1, variant))]!;
  return { y: seatHeight - contact * scale, z: SEAT_FORWARD * scale };
}

export type Person = {
  /** Positioned and turned by the scene (like the procedural rig's group). */
  root: ThreeNS.Group;
  variant: number;
  /** The clip playing now (null before the first play). */
  readonly clip: PersonClip | null;
  /** Height of the head top above the floor in world units, follows the seat lift. */
  headTop: number;
  play: (clip: PersonClip, fadeSeconds?: number, startOffsetSeconds?: number) => void;
  setTimeScale: (scale: number) => void;
  /** 0 standing … 1 seated on a seat of this height. */
  setSeat: (amount: number, seatHeight: number) => void;
  update: (dt: number) => void;
  dispose: () => void;
};

export type OfficePeople = {
  createPerson: (variant: number) => Person;
  dispose: () => void;
};

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Parses the embedded GLB once: bone names restored, toon materials on the shared gradient, clips shared. */
export async function loadOfficePeople(THREE: Three): Promise<OfficePeople> {
  const [{ GLTFLoader }, SkeletonUtils, { OFFICE_PEOPLE_GLB_BASE64 }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/utils/SkeletonUtils.js"),
    import("./assets/office-people-glb"),
  ]);
  const buffer = decodeBase64(OFFICE_PEOPLE_GLB_BASE64);
  const gltf = await new Promise<{ scene: ThreeNS.Group; animations: ThreeNS.AnimationClip[] }>((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", resolve, reject);
  });

  // GLTFLoader makes node names unique (Hips_1, Spine_2 …); the clips address the plain names
  gltf.scene.traverse((o) => {
    if ((o as ThreeNS.Bone).isBone && typeof o.userData.name === "string") o.name = o.userData.name;
  });

  const style = getPixelStyle(THREE);
  const owned: Array<{ dispose: () => void }> = [];
  gltf.scene.traverse((o) => {
    const mesh = o as ThreeNS.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const old = mesh.material as ThreeNS.MeshStandardMaterial;
    if (old.map) old.map.colorSpace = THREE.SRGBColorSpace;
    const toon = style.toon({ map: old.map ?? null, emissive: 0x333333, emissiveMap: old.map ?? null });
    old.dispose();
    mesh.material = toon;
    mesh.frustumCulled = false; // quantized positions pop out of the culling box
    owned.push(toon, mesh.geometry);
    if (toon.map) owned.push(toon.map);
  });

  const clips = new Map<string, ThreeNS.AnimationClip>(gltf.animations.map((c) => [c.name, c]));
  const cupMaterial = style.toon({ color: 0xf4f1ea });
  owned.push(cupMaterial);
  const cupGeometry = new THREE.CylinderGeometry(0.035, 0.03, 0.07, 8);
  owned.push(cupGeometry);

  const createPerson = (variant: number): Person => {
    const source = gltf.scene.getObjectByName(`char_${variant}`);
    if (!source) throw new Error(`office-people: char_${variant} missing`);
    const body = SkeletonUtils.clone(source) as ThreeNS.Object3D;
    const root = new THREE.Group();
    const holder = new THREE.Group();
    holder.scale.setScalar(PERSON_SCALE);
    holder.add(body);
    root.add(holder);

    const cup = new THREE.Mesh(cupGeometry, cupMaterial);
    cup.visible = false;
    const hand = body.getObjectByName("RightHand");
    if (hand) {
      cup.position.set(0, 0.06, 0);
      hand.add(cup);
    }

    const mixer = new THREE.AnimationMixer(body);
    const actions = new Map<PersonClip, ThreeNS.AnimationAction>();
    let current: ThreeNS.AnimationAction | null = null;
    let currentName: PersonClip | null = null;
    let timeScale = 1;

    const person: Person = {
      root,
      variant,
      get clip() {
        return currentName;
      },
      headTop: 1.4 * PERSON_SCALE,
      play(name, fade = CLIP_FADE, startOffset = 0) {
        if (name === currentName) return;
        let next = actions.get(name);
        if (!next) {
          const clip = clips.get(name);
          if (!clip) return;
          next = mixer.clipAction(clip);
          actions.set(name, next);
        }
        next.reset();
        next.time = startOffset % Math.max(0.01, next.getClip().duration);
        next.enabled = true;
        next.setEffectiveWeight(1);
        next.setEffectiveTimeScale(name === "Walk" ? timeScale : 1);
        if (current && fade > 0) {
          next.crossFadeFrom(current, fade, false);
        } else if (current) {
          current.stop();
        }
        next.play();
        current = next;
        currentName = name;
        cup.visible = name === "Drink";
      },
      setTimeScale(scale) {
        timeScale = scale;
        if (current && currentName === "Walk") current.setEffectiveTimeScale(scale);
      },
      setSeat(amount, height) {
        const sit = Math.max(0, Math.min(1, amount));
        const eased = sit * sit * (3 - 2 * sit);
        const placement = seatPlacement(variant, height);
        holder.position.set(0, placement.y * eased, placement.z * eased);
        person.headTop = 1.4 * PERSON_SCALE - 0.185 * PERSON_SCALE * eased + placement.y * eased;
      },
      update(dt) {
        mixer.update(dt);
      },
      dispose() {
        mixer.stopAllAction();
        mixer.uncacheRoot(body);
        root.removeFromParent();
      },
    };
    person.setSeat(0, SEAT_HEIGHT_CHAIR);
    return person;
  };

  return {
    createPerson,
    dispose() {
      for (const item of owned) {
        try {
          item.dispose();
        } catch {
          // already released
        }
      }
    },
  };
}
