/**
 * Rigged chibi people (office-people.glb): eight characters, one skeleton layout, ten shared clips. The pure helpers
 * (clip choice, seat placement, walk speed) have no three.js dependency and are unit tested.
 */
import type * as ThreeNS from "three";
import { loadModel, toToon } from "./assets";
import { getPixelStyle } from "./pixel";

type Three = typeof ThreeNS;

/** The GLB file the people live in. */
export const PEOPLE_ASSET = "office-people.glb";
/** Characters in the GLB (`char_0` … `char_7`). */
export const PERSON_VARIANTS = 8;
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

export type PersonState = {
  walking: boolean;
  /** Seated (the transition is done by the seat lift; the clip follows the target at once). */
  sitting: boolean;
  /** What the scene says the person does: "speaking", "arguing", "waiting", "idle" … */
  activity: string;
  /** Finer action: "typing", "chat", "coffee", "bar", "operate", "window". */
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

export type People = {
  createPerson: (variant: number) => Person;
  dispose: () => void;
};

/** Seat height `setSeat(0, …)` starts from (a plain chair). */
const DEFAULT_SEAT_HEIGHT = 0.52;

/** Parses the GLB once: bone names restored, toon materials on the shared gradient, clips shared. */
export async function loadPeople(THREE: Three, asset: string = PEOPLE_ASSET): Promise<People> {
  const model = await loadModel(asset);
  const style = getPixelStyle(THREE);
  const owned: Array<{ dispose: () => void }> = [];
  model.scene.traverse((o) => {
    if ((o as ThreeNS.SkinnedMesh).isSkinnedMesh) toToon(THREE, o as ThreeNS.SkinnedMesh, owned);
  });

  const clips = new Map<string, ThreeNS.AnimationClip>(model.animations.map((c) => [c.name, c]));
  const cupMaterial = style.toon({ color: 0xf4f1ea });
  owned.push(cupMaterial);
  const cupGeometry = new THREE.CylinderGeometry(0.035, 0.03, 0.07, 8);
  owned.push(cupGeometry);

  const createPerson = (variant: number): Person => {
    const source = model.scene.getObjectByName(`char_${variant}`);
    if (!source) throw new Error(`pixel-world people: char_${variant} missing`);
    const body = model.clone(source);
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
    person.setSeat(0, DEFAULT_SEAT_HEIGHT);
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
