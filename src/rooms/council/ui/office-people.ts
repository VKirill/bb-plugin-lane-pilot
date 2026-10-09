/**
 * The people of the council office. The rigged characters and their clips come from @lane-pilot/pixel-world
 * (assets/world/office-people.glb, served over HTTP); the procedural rig in office-character.ts stays as the fallback
 * while that loads or if it cannot. What is office-specific lives here: which character a seat gets, and the seat heights.
 *
 * The pure helpers (variant choice, seat heights) have no three.js dependency and are unit tested.
 */
import { PERSON_VARIANTS } from "@lane-pilot/pixel-world";
import { OWNER_SEAT_ID, RECEPTIONIST_ID } from "./office-behaviour";
import { hashId } from "./office-character";

export const OWNER_VARIANT = 0;
export const RECEPTIONIST_VARIANT = 5;

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

/** Seat top heights of the furniture in office-scene.ts. */
export const SEAT_HEIGHT_CHAIR = 0.52;
export const SEAT_HEIGHT_SOFA = 0.5;
export const SEAT_HEIGHT_STOOL = 0.7;

export function seatHeightForPoint(pointId: string | undefined, kind: string | undefined): number {
  if (pointId?.startsWith("pt_stool")) return SEAT_HEIGHT_STOOL;
  if (kind === "sofa") return SEAT_HEIGHT_SOFA;
  return SEAT_HEIGHT_CHAIR;
}
