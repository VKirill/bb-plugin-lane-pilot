import type { FloorRect } from "@lane-pilot/pixel-world";

/** Grid rectangle gx0–gx1 × gz0–gz1 as a world footprint (x = gx − 20, z = gz − 10). */
const g = (gx0: number, gx1: number, gz0: number, gz1: number): FloorRect => ({
  minX: gx0 - 20,
  maxX: gx1 - 20,
  minZ: gz0 - 10,
  maxZ: gz1 - 10,
});

/** Floor footprints of the part-B props that people must walk around (world units). */
export const BLOCKERS_B: FloorRect[] = [
  // Lounge: two beanbags, side table with a lamp, magazine rack, guitar against the west wall
  g(1.05, 2.05, 17.7, 18.7),
  g(1.0, 1.95, 14.45, 15.35),
  g(6.65, 7.35, 18.45, 19.15),
  g(7.15, 7.85, 13.15, 13.65),
  g(0.2, 0.6, 14.3, 14.7),
  // Kitchen: dining table with two chairs, water crate, recycling trio, plant
  g(18.75, 20.25, 16.05, 18.75),
  g(19.6, 20.05, 14.0, 14.35),
  g(11.9, 13.5, 19.15, 19.75),
  g(11.25, 11.7, 15.0, 15.45),
  // Server room: UPS and network rack along the east wall, crash cart, spare-parts boxes
  g(27.0, 27.8, 15.6, 17.75),
  g(24.9, 25.6, 16.2, 16.9),
  g(21.2, 21.95, 18.5, 19.85),
  // Entrance: waiting nook (sofa, table, armchair), mail cabinet, water dispenser, umbrella stand, plant
  g(29.95, 34.25, 17.95, 19.85),
  g(28.2, 28.7, 13.8, 15.2),
  g(28.2, 28.7, 17.3, 17.9),
  g(39.4, 39.8, 19.2, 19.6),
  g(37.2, 37.8, 13.2, 13.8),
  g(35.6, 36.3, 13.2, 13.6),
];
