import type { FloorRect } from "@lane-pilot/pixel-world";

/** Grid rectangle gx0–gx1 × gz0–gz1 as a world footprint (local copy: office-layout imports this file). */
const r = (gx0: number, gx1: number, gz0: number, gz1: number): FloorRect => ({ minX: gx0 - 20, maxX: gx1 - 20, minZ: gz0 - 10, maxZ: gz1 - 10 });

/** Floor footprints of the part-A props that people must walk around (world units). */
export const BLOCKERS_A: FloorRect[] = [
  // Meeting room: credenza under the whiteboard, coat rack, flip chart
  r(0, 0.58, 7.3, 9.9),
  r(0.35, 0.85, 10.15, 10.55),
  r(9.55, 10.65, 0.45, 0.95),
  r(1.33, 3.75, 0, 0.55),
  r(11.05, 11.65, 0.4, 1.0),
  // Open space, north wall: lockers, filing cabinet, bookcase, planter, low cabinets
  r(12.2, 12.95, 0, 0.5),
  r(16.15, 16.85, 0, 0.55),
  r(20.1, 20.9, 0, 0.5),
  r(17.2, 19.8, 0, 0.5),
  r(21.2, 23.85, 0, 0.5),
  // Open space, free strip: copier, paper boxes, ficus, kanban, dog bed, bins
  r(12.4, 13.3, 7.2, 8.5),
  r(12.45, 12.95, 8.7, 9.15),
  r(12.65, 13.25, 6.0, 6.6),
  r(22.1, 24.3, 6.95, 7.45),
  r(22.3, 23.4, 9.0, 9.8),
  r(14.0, 14.8, 9.4, 9.9),
  r(12.45, 12.95, 9.45, 9.85),
  r(13.05, 13.55, 1.15, 1.65),
  r(13.33, 13.77, 3.58, 4.02),
  r(19.53, 19.97, 4.28, 4.72),
  // Corridor: benches, umbrella stand, wet floor sign
  r(1.8, 3.6, 11.22, 11.74),
  r(37.0, 38.8, 11.22, 11.74),
  r(11.2, 11.6, 11.3, 11.7),
  r(15.0, 15.4, 12.5, 12.71),
];
