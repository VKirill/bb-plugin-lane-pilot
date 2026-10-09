import { createNavGrid } from "@lane-pilot/pixel-world";
import { BLOCKERS_A } from "./office-blockers-a";
import { BLOCKERS_B } from "./office-blockers-b";

// Floor geometry, props and the office behaviour engine (.agents/design/council-office/reference.md §1, §2, §5).
// Authoring uses grid coords (gx 0–40, gz 0–20); the rest of the module works in world units (x = gx − 20, z = gz − 10).

export type ZoneKind =
  | "meeting"
  | "open_space"
  | "director"
  | "corridor"
  | "kitchen"
  | "lounge"
  | "server_room"
  | "entrance";

export type PropKind =
  | "meeting_table"
  | "meeting_chair"
  | "workstation_desk"
  | "workstation_chair"
  | "director_desk"
  | "coffee_counter"
  | "water_cooler"
  | "sofa"
  | "coffee_table"
  | "bookshelf"
  | "bar"
  | "server_rack"
  | "printer"
  | "plant"
  | "window_ledge"
  | "reception"
  | "bench"
  | "marker"
  | "decor";

export type InteractionPointKind =
  | "meeting_seat"
  | "meeting_speak"
  | "desk"
  | "coffee"
  | "water"
  | "sofa"
  | "window"
  | "chat"
  | "printer"
  | "director_chair"
  | "bar"
  | "report"
  | "reception"
  | "server"
  | "browse";

export type InteractionPose =
  | "sitting_table"
  | "speaking"
  | "arguing"
  | "typing"
  | "drinking"
  | "sitting_sofa"
  | "window_gaze"
  | "chatting"
  | "operating";

export type InteractionPoint = {
  id: string;
  propId: string;
  kind: InteractionPointKind;
  x: number;
  z: number;
  approachAngle: number;
  pose: InteractionPose;
  capacity: number;
  zone: ZoneKind;
  assignedTo?: string; // dedicated seatId, or "owner" for the director's office
  /** Where the body ends up when the spot is on furniture that blocks walking (a sofa seat); x/z is where one walks to. */
  seatX?: number;
  seatZ?: number;
};

export type PropFootprint = {
  id: string;
  kind: PropKind;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  zone: ZoneKind;
  interactionPoints: InteractionPoint[];
  /** Props that do not block walking (chairs, markers) set this to false. Default true. */
  blocks?: boolean;
};

export type WallSegment = {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  isInterior?: boolean;
};

export const GRID_W = 40;
export const GRID_H = 20;

/** Floor in world units: x −20…20, z −10…10 (grid 40×20). */
export const FLOOR_BOUNDS = {
  minX: -20,
  maxX: 20,
  minZ: -10,
  maxZ: 10,
};

// Facing angles: 0 = +Z (south, towards the camera), PI = north, ±PI/2 = east/west.
export const FACE_SOUTH = 0;
export const FACE_NORTH = Math.PI;
export const FACE_EAST = Math.PI / 2;
export const FACE_WEST = -Math.PI / 2;

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Grid rectangle gx0–gx1 × gz0–gz1 as a world footprint. */
export function gridRect(gx0: number, gx1: number, gz0: number, gz1: number): Rect {
  return { minX: gx0 - 20, maxX: gx1 - 20, minZ: gz0 - 10, maxZ: gz1 - 10 };
}

/** Grid point (gx, gz) as world x/z. */
export function gridPoint(gx: number, gz: number): { x: number; z: number } {
  return { x: gx - 20, z: gz - 10 };
}

function point(
  id: string,
  propId: string,
  kind: InteractionPointKind,
  gx: number,
  gz: number,
  approachAngle: number,
  pose: InteractionPose,
  zone: ZoneKind,
  extra: { capacity?: number; assignedTo?: string; seat?: [number, number] } = {}
): InteractionPoint {
  const { x, z } = gridPoint(gx, gz);
  const seat = extra.seat ? gridPoint(extra.seat[0], extra.seat[1]) : null;
  return {
    id,
    propId,
    kind,
    x,
    z,
    approachAngle,
    pose,
    capacity: extra.capacity ?? 1,
    zone,
    ...(extra.assignedTo ? { assignedTo: extra.assignedTo } : {}),
    ...(seat ? { seatX: seat.x, seatZ: seat.z } : {}),
  };
}

function prop(
  id: string,
  kind: PropKind,
  zone: ZoneKind,
  area: Rect,
  interactionPoints: InteractionPoint[] = [],
  blocks = true
): PropFootprint {
  return { id, kind, ...area, zone, interactionPoints, blocks };
}

function wallX(id: string, gxLine: number, gz0: number, gz1: number): WallSegment {
  return { id, ...gridRect(gxLine - 0.15, gxLine + 0.15, gz0, gz1), height: 1.4, isInterior: true };
}

function wallZ(id: string, gzLine: number, gx0: number, gx1: number): WallSegment {
  return { id, ...gridRect(gx0, gx1, gzLine - 0.15, gzLine + 0.15), height: 1.4, isInterior: true };
}

// Interior walls and the doorways between rooms (reference.md §1 Walls).
// Outer walls are the floor bounds; the front edge is a cutaway stub.
export const OFFICE_WALLS: WallSegment[] = [
  wallX("wall_meeting_e", 12, 0, 11),
  wallZ("wall_meeting_s_w", 11, 0, 8.5),
  wallZ("wall_meeting_s_e", 11, 10.5, 12),
  wallX("wall_director_w", 26, 0, 11),
  wallZ("wall_director_s_w", 11, 26, 33.8),
  wallZ("wall_director_s_e", 11, 35.8, 40),
  wallZ("wall_lounge_n_w", 13, 0, 8.5),
  wallZ("wall_lounge_n_e", 13, 10.5, 11),
  wallX("wall_lounge_kitchen", 11, 13, 20),
  wallZ("wall_kitchen_n_w", 13, 11, 11.5),
  wallZ("wall_kitchen_n_e", 13, 13.5, 21),
  wallX("wall_kitchen_server", 21, 13, 20),
  wallZ("wall_server_n_w", 13, 21, 26),
  wallZ("wall_server_n_e", 13, 27.5, 28),
  wallX("wall_server_entrance", 28, 13, 20),
];

/** Council seats in the meeting room: 10 chairs (chair head, owner head, 4 north, 4 south). */
const MEETING_SEAT_DEFS: Array<{ id: string; seatId: string; gx: number; gz: number; angle: number }> = [
  { id: "chair_head", seatId: "chair", gx: 1.3, gz: 5, angle: FACE_EAST },
  { id: "owner_head", seatId: "owner", gx: 10.7, gz: 5, angle: FACE_WEST },
  { id: "n1", seatId: "n1", gx: 3, gz: 3.3, angle: FACE_SOUTH },
  { id: "n2", seatId: "n2", gx: 5, gz: 3.3, angle: FACE_SOUTH },
  { id: "n3", seatId: "n3", gx: 7, gz: 3.3, angle: FACE_SOUTH },
  { id: "n4", seatId: "n4", gx: 9, gz: 3.3, angle: FACE_SOUTH },
  { id: "s1", seatId: "s1", gx: 3, gz: 6.7, angle: FACE_NORTH },
  { id: "s2", seatId: "s2", gx: 5, gz: 6.7, angle: FACE_NORTH },
  { id: "s3", seatId: "s3", gx: 7, gz: 6.7, angle: FACE_NORTH },
  { id: "s4", seatId: "s4", gx: 9, gz: 6.7, angle: FACE_NORTH },
];

/** Open-space desks: 2×1 blocks with the chair on the side the person sits. */
const DESK_DEFS: Array<{ id: string; area: [number, number, number, number]; chair: [number, number]; angle: number }> = [
  { id: "a1", area: [14, 16, 3, 4], chair: [15, 2.4], angle: FACE_SOUTH },
  { id: "a2", area: [16, 18, 3, 4], chair: [17, 2.4], angle: FACE_SOUTH },
  { id: "a3", area: [14, 16, 4, 5], chair: [15, 5.6], angle: FACE_NORTH },
  { id: "a4", area: [16, 18, 4, 5], chair: [17, 5.6], angle: FACE_NORTH },
  { id: "b1", area: [20, 22, 3, 4], chair: [21, 2.4], angle: FACE_SOUTH },
  { id: "b2", area: [22, 24, 3, 4], chair: [23, 2.4], angle: FACE_SOUTH },
  { id: "b3", area: [20, 22, 4, 5], chair: [21, 5.6], angle: FACE_NORTH },
  { id: "b4", area: [22, 24, 4, 5], chair: [23, 5.6], angle: FACE_NORTH },
];

export const OWNER_SEAT_ID = "owner";
/** Background staff: they live on the floor and never join the council. */
export const STAFF_PREFIX = "staff_";
export const RECEPTIONIST_ID = "staff_reception";
export const isStaffId = (id: string) => id.startsWith(STAFF_PREFIX);
export const OWNER_HOME_POINT_ID = "pt_director_chair";

export const OFFICE_PROPS: PropFootprint[] = [
  // ---- Meeting room (gx 0–12, gz 0–11) ----
  prop("prop_meeting_table", "meeting_table", "meeting", gridRect(2, 10, 4, 6)),
  prop("prop_meeting_speak", "marker", "meeting", gridRect(5.7, 6.3, 1.7, 2.3), [
    point("pt_meeting_speak", "prop_meeting_speak", "meeting_speak", 6, 2, FACE_SOUTH, "speaking", "meeting"),
  ], false),
  prop("prop_plant_monstera", "plant", "meeting", gridRect(0.2, 1.0, 0.2, 1.0)),
  prop("prop_plant_meeting", "plant", "meeting", gridRect(11.0, 11.8, 10.0, 10.8)),
  ...MEETING_SEAT_DEFS.map((seat) => {
    const propId = `prop_chair_${seat.id}`;
    return prop(propId, "meeting_chair", "meeting", gridRect(seat.gx - 0.3, seat.gx + 0.3, seat.gz - 0.3, seat.gz + 0.3), [
      point(`pt_${seat.id}`, propId, "meeting_seat", seat.gx, seat.gz, seat.angle, "sitting_table", "meeting", { assignedTo: seat.seatId }),
    ], false);
  }),

  // ---- Open space (gx 12–26, gz 0–11) ----
  ...DESK_DEFS.flatMap((desk) => {
    const [x0, x1, z0, z1] = desk.area;
    const deskId = `prop_desk_${desk.id}`;
    const chairId = `prop_chair_desk_${desk.id}`;
    return [
      prop(deskId, "workstation_desk", "open_space", gridRect(x0, x1, z0, z1)),
      prop(chairId, "workstation_chair", "open_space", gridRect(desk.chair[0] - 0.3, desk.chair[0] + 0.3, desk.chair[1] - 0.3, desk.chair[1] + 0.3), [
        point(`pt_desk_${desk.id}`, chairId, "desk", desk.chair[0], desk.chair[1], desk.angle, "typing", "open_space"),
      ], false),
    ];
  }),
  prop("prop_planter_13", "plant", "open_space", gridRect(12.7, 13.3, 10.1, 10.7)),
  prop("prop_planter_19", "plant", "open_space", gridRect(18.7, 19.3, 10.1, 10.7)),
  prop("prop_planter_25", "plant", "open_space", gridRect(24.7, 25.3, 10.1, 10.7)),
  prop("prop_plant_open", "plant", "open_space", gridRect(25.2, 25.8, 0.3, 0.9)),
  // Two people standing and talking in the free strip of the open space (gz 6–10)
  prop("prop_chat_open", "marker", "open_space", gridRect(18.2, 20.0, 7.6, 8.4), [
    point("pt_chat_open_a", "prop_chat_open", "chat", 18.6, 8, FACE_EAST, "chatting", "open_space"),
    point("pt_chat_open_b", "prop_chat_open", "chat", 19.6, 8, FACE_WEST, "chatting", "open_space"),
  ], false),

  // ---- Director's office (gx 26–40, gz 0–11) ----
  prop("prop_bookshelf_1", "bookshelf", "director", gridRect(26.15, 26.75, 0.6, 2.4)),
  prop("prop_bookshelf_2", "bookshelf", "director", gridRect(26.15, 26.75, 2.4, 4.2)),
  prop("prop_bookshelf_3", "bookshelf", "director", gridRect(26.15, 26.75, 4.2, 6.0)),
  prop("prop_bust", "decor", "director", gridRect(28.7, 29.3, 0.4, 1.0)),
  prop("prop_director_desk", "director_desk", "director", gridRect(32.8, 36.8, 3.0, 4.4), [
    point("pt_director_chair", "prop_director_desk", "director_chair", 34.8, 2.25, FACE_SOUTH, "typing", "director", { assignedTo: OWNER_SEAT_ID }),
  ]),
  prop("prop_director_window", "marker", "director", gridRect(29.9, 30.9, 0.6, 1.6), [
    point("pt_director_window", "prop_director_window", "window", 30.4, 1.1, FACE_NORTH, "window_gaze", "director", { assignedTo: OWNER_SEAT_ID }),
  ], false),
  prop("prop_credenza", "decor", "director", gridRect(31.6, 38.0, 0.3, 0.9)),
  prop("prop_chesterfield", "sofa", "director", gridRect(27.6, 30.6, 6.6, 7.5)),
  prop("prop_armchair_w", "decor", "director", gridRect(26.5, 27.4, 8.0, 8.9)),
  prop("prop_armchair_e", "decor", "director", gridRect(30.8, 31.7, 8.0, 8.9)),
  prop("prop_director_coffee", "coffee_table", "director", gridRect(28.4, 29.8, 8.0, 8.8)),
  prop("prop_globe", "decor", "director", gridRect(38.5, 39.3, 1.3, 2.1)),
  prop("prop_plant_fig", "plant", "director", gridRect(39.0, 39.6, 0.3, 0.9)),
  prop("prop_plant_bird", "plant", "director", gridRect(39.0, 39.6, 5.3, 5.9)),
  prop("prop_plant_director", "plant", "director", gridRect(32.1, 32.7, 10.0, 10.6)),
  prop("prop_bar", "bar", "director", gridRect(36.6, 39.4, 7.6, 8.4), [
    point("pt_director_bar", "prop_bar", "bar", 38.0, 7.0, FACE_SOUTH, "drinking", "director", { assignedTo: OWNER_SEAT_ID }),
  ]),
  prop("prop_guest_chair_1", "workstation_chair", "director", gridRect(33.4, 34.2, 4.9, 5.7), [], false),
  prop("prop_guest_chair_2", "workstation_chair", "director", gridRect(35.4, 36.2, 4.9, 5.7), [], false),

  // ---- Corridor (gz 11–13) ----
  prop("prop_report_spot", "marker", "corridor", gridRect(33.8, 35.8, 11.6, 12.2), [
    point("pt_director_report_1", "prop_report_spot", "report", 34.3, 11.9, FACE_NORTH, "chatting", "corridor"),
    point("pt_director_report_2", "prop_report_spot", "report", 35.3, 11.9, FACE_NORTH, "chatting", "corridor"),
  ], false),
  prop("prop_plant_corridor_w", "plant", "corridor", gridRect(0.2, 1.0, 11.7, 12.3)),
  prop("prop_plant_corridor_e", "plant", "corridor", gridRect(39.0, 39.8, 11.7, 12.3)),
  prop("prop_door_plant_1", "plant", "corridor", gridRect(32.9, 33.5, 11.15, 11.75)),
  prop("prop_door_plant_2", "plant", "corridor", gridRect(36.1, 36.7, 11.15, 11.75)),

  // ---- Kitchen / coffee point (gx 11–21, gz 13–20) ----
  prop("prop_coffee_counter", "coffee_counter", "kitchen", gridRect(14, 18, 13.2, 13.9), [
    point("pt_coffee_1", "prop_coffee_counter", "coffee", 15.5, 14.4, FACE_NORTH, "drinking", "kitchen"),
    point("pt_coffee_2", "prop_coffee_counter", "coffee", 17.5, 14.4, FACE_NORTH, "drinking", "kitchen"),
  ]),
  prop("prop_fridge", "decor", "kitchen", gridRect(18.2, 19.2, 13.1, 14.0)),
  prop("prop_water_cooler", "water_cooler", "kitchen", gridRect(19.6, 20.4, 13.2, 14.0), [
    point("pt_water", "prop_water_cooler", "water", 20.0, 14.6, FACE_NORTH, "drinking", "kitchen"),
  ]),
  prop("prop_bar_island", "decor", "kitchen", gridRect(14, 18, 16, 17)),
  // Bar stools at the island: sit with a coffee, facing the island
  prop("prop_stools", "marker", "kitchen", gridRect(14.2, 17.8, 17.4, 18.0), [
    point("pt_stool_1", "prop_stools", "coffee", 14.5, 17.7, FACE_NORTH, "sitting_sofa", "kitchen"),
    point("pt_stool_2", "prop_stools", "coffee", 16, 17.7, FACE_NORTH, "sitting_sofa", "kitchen"),
    point("pt_stool_3", "prop_stools", "coffee", 17.5, 17.7, FACE_NORTH, "sitting_sofa", "kitchen"),
  ], false),
  prop("prop_bin", "decor", "kitchen", gridRect(11.25, 11.65, 19.25, 19.65)),
  prop("prop_plant_kitchen", "plant", "kitchen", gridRect(20.1, 20.7, 19.1, 19.7)),

  // ---- Lounge (gx 0–11, gz 13–20) ----
  prop("prop_tv_cabinet", "decor", "lounge", gridRect(2, 5, 13.2, 13.8)),
  prop("prop_bookshelf_lounge", "bookshelf", "lounge", gridRect(5.5, 7, 13.2, 13.7), [
    point("pt_bookshelf", "prop_bookshelf_lounge", "browse", 6.25, 14.3, FACE_NORTH, "operating", "lounge"),
  ]),
  prop("prop_floor_lamp", "decor", "lounge", gridRect(0.8, 1.2, 13.8, 14.2)),
  prop("prop_lounge_table", "coffee_table", "lounge", gridRect(3.5, 5.5, 16, 17)),
  prop("prop_sofa_a", "sofa", "lounge", gridRect(2.5, 6.5, 18.2, 19.2), [
    point("pt_sofa_1", "prop_sofa_a", "sofa", 3.5, 17.6, FACE_NORTH, "sitting_sofa", "lounge", { seat: [3.5, 18.6] }),
    point("pt_sofa_2", "prop_sofa_a", "sofa", 5.5, 17.6, FACE_NORTH, "sitting_sofa", "lounge", { seat: [5.5, 18.6] }),
  ]),
  prop("prop_sofa_b", "sofa", "lounge", gridRect(7.6, 8.6, 15, 18), [
    point("pt_sofa_3", "prop_sofa_b", "sofa", 9.2, 16.5, FACE_WEST, "sitting_sofa", "lounge", { seat: [8.0, 16.5] }),
  ]),
  prop("prop_window_lounge", "window_ledge", "lounge", gridRect(0.6, 1.4, 16, 17), [
    point("pt_window_lounge", "prop_window_lounge", "window", 1.0, 16.5, FACE_WEST, "window_gaze", "lounge"),
  ], false),
  prop("prop_plant_lounge_w", "plant", "lounge", gridRect(0.2, 1.0, 18.9, 19.9)),
  prop("prop_plant_lounge_e", "plant", "lounge", gridRect(10.1, 10.7, 19.1, 19.7)),

  // ---- Server room (gx 21–28, gz 13–20) ----
  prop("prop_rack_1", "server_rack", "server_room", gridRect(21.6, 22.8, 13.3, 14.5)),
  prop("prop_rack_2", "server_rack", "server_room", gridRect(23.0, 24.2, 13.3, 14.5)),
  prop("prop_rack_3", "server_rack", "server_room", gridRect(24.4, 25.6, 13.3, 14.5)),
  prop("prop_ac_unit", "decor", "server_room", gridRect(26.8, 27.6, 18.6, 19.6)),
  prop("prop_printer", "printer", "server_room", gridRect(22.0, 23.2, 18.4, 19.4), [
    point("pt_printer", "prop_printer", "printer", 22.6, 17.8, FACE_SOUTH, "operating", "server_room"),
  ]),
  prop("prop_server_spot", "marker", "server_room", gridRect(22.9, 23.9, 14.8, 15.6), [
    point("pt_server", "prop_server_spot", "server", 23.4, 15.2, FACE_NORTH, "operating", "server_room"),
  ], false),

  // ---- Entrance / reception (gx 28–40, gz 13–20) ----
  prop("prop_reception", "reception", "entrance", gridRect(31, 32, 14, 17)),
  prop("prop_coat_stand", "decor", "entrance", gridRect(39.05, 39.45, 13.65, 14.05)),
  prop("prop_bench", "bench", "entrance", gridRect(35.5, 38.5, 19.2, 19.8)),
  prop("prop_plant_entrance_1", "plant", "entrance", gridRect(39.1, 39.7, 15.1, 15.7)),
  prop("prop_plant_entrance_2", "plant", "entrance", gridRect(39.1, 39.7, 18.3, 18.9)),
  prop("prop_plant_entrance_3", "plant", "entrance", gridRect(28.3, 28.9, 19.1, 19.7)),
  prop("prop_chat_entrance", "marker", "entrance", gridRect(34.2, 35.8, 14.6, 15.4), [
    point("pt_chat_entrance", "prop_chat_entrance", "chat", 34.6, 15, FACE_EAST, "chatting", "entrance"),
    point("pt_chat_entrance_b", "prop_chat_entrance", "chat", 35.6, 15, FACE_WEST, "chatting", "entrance"),
  ], false),
  prop("prop_reception_chair", "workstation_chair", "entrance", gridRect(30.1, 30.7, 15.2, 15.8), [
    point("pt_reception", "prop_reception_chair", "reception", 30.4, 15.5, FACE_EAST, "typing", "entrance", { assignedTo: RECEPTIONIST_ID }),
  ], false),
];

export const ALL_INTERACTION_POINTS: InteractionPoint[] = OFFICE_PROPS.flatMap((p) => p.interactionPoints);

/** Floor-standing extra props from the prop modules: people walk around them. */
const EXTRA_BLOCKERS = [...BLOCKERS_A, ...BLOCKERS_B];

const POINTS_BY_ID = new Map(ALL_INTERACTION_POINTS.map((p) => [p.id, p] as const));

/**
 * The walking grid of the office, built once: the floor bounds, the walls, the extra blockers of the prop modules and
 * every prop that blocks. (The engine, packages/pixel-world/src/nav.ts, answers the queries.)
 */
const OFFICE_NAV = createNavGrid({
  bounds: FLOOR_BOUNDS,
  obstacles: [...OFFICE_WALLS, ...EXTRA_BLOCKERS, ...OFFICE_PROPS.filter((p) => p.blocks !== false)],
});

/**
 * Checks if a world coordinate is blocked by the floor bounds, walls or blocking props.
 */
export function isOfficeFloorBlocked(x: number, z: number, margin = 0.15): boolean {
  return OFFICE_NAV.isBlocked(x, z, margin);
}

/**
 * Checks whether a straight line between two world points crosses a wall or a blocking prop.
 */
export function isOfficeSegmentBlocked(x1: number, z1: number, x2: number, z2: number, margin = 0.08): boolean {
  return OFFICE_NAV.isSegmentBlocked(x1, z1, x2, z2, margin);
}

/**
 * A* grid pathfinder across the office floor. Returns string-pulled waypoints ending at the target.
 */
export function findOfficeFloorPath(
  start: { x: number; z: number },
  target: { x: number; z: number }
): Array<{ x: number; z: number }> {
  return OFFICE_NAV.findPath(start, target);
}

// ==========================================
// SEATS & SPOTS
// ==========================================

export type OfficeSeat = {
  id: string;
  seatId: string;
  pointId: string;
  x: number;
  z: number;
  angle: number;
  speakX: number;
  speakZ: number;
};

/** The 10 meeting chairs. Index 0 is the chair head, index 1 the owner head. */
export const OFFICE_SEATS: OfficeSeat[] = (() => {
  const speak = gridPoint(6, 2);
  return MEETING_SEAT_DEFS.map((seat) => {
    const { x, z } = gridPoint(seat.gx, seat.gz);
    return {
      id: `seat_${seat.id}`,
      seatId: seat.seatId,
      pointId: `pt_${seat.id}`,
      x,
      z,
      angle: seat.angle,
      speakX: speak.x,
      speakZ: speak.z,
    };
  });
})();

export type OfficeSpotAction = "typing" | "coffee" | "sofa" | "window" | "chat" | "report" | "bar" | "errand";

export type OfficeSpot = {
  key: string;
  x: number;
  z: number;
  angle: number;
  action: OfficeSpotAction;
  sit: boolean;
};

function spotFromPoint(p: InteractionPoint): OfficeSpot {
  const action: OfficeSpotAction =
    p.kind === "desk" || p.kind === "director_chair" || p.kind === "reception"
      ? "typing"
      : p.kind === "coffee" || p.kind === "water"
      ? "coffee"
      : p.kind === "sofa"
      ? "sofa"
      : p.kind === "window"
      ? "window"
      : p.kind === "bar"
      ? "bar"
      : p.kind === "report"
      ? "report"
      : p.kind === "printer" || p.kind === "server" || p.kind === "browse"
      ? "errand"
      : "chat";
  return {
    key: p.id,
    x: p.x,
    z: p.z,
    angle: p.approachAngle,
    action,
    sit: p.pose === "typing" || p.pose === "sitting_sofa",
  };
}

const AMBIENT_KINDS: ReadonlySet<InteractionPointKind> = new Set(["desk", "coffee", "water", "sofa", "window", "chat", "report", "printer", "server", "browse"]);

/** Spots for council seats and ambient people. Owner-only points are excluded. */
export const OFFICE_SPOTS: Record<string, OfficeSpot> = Object.fromEntries(
  ALL_INTERACTION_POINTS.filter((p) => AMBIENT_KINDS.has(p.kind) && !p.assignedTo).map((p) => [p.id, spotFromPoint(p)])
);

/** The owner's own spots: H (home chair), W (window), B (bar). */
export const OWNER_SPOTS: Record<string, OfficeSpot> = Object.fromEntries(
  ALL_INTERACTION_POINTS.filter((p) => p.assignedTo === OWNER_SEAT_ID && p.kind !== "meeting_seat").map((p) => [p.id, spotFromPoint(p)])
);

export function getInteractionPoint(id: string): InteractionPoint | undefined {
  return POINTS_BY_ID.get(id);
}

/**
 * Assigns distinct meeting chairs to each actor: the chair actor gets the chair head, the owner the owner head.
 */
export function assignOfficeSeats(actors: Array<{ id: string }>): Map<string, OfficeSeat> {
  const assignments = new Map<string, OfficeSeat>();
  const usedSeatIndices = new Set<number>();

  actors.forEach((actor) => {
    let seatIdx = -1;
    if (actor.id === "chair" && !usedSeatIndices.has(0)) seatIdx = 0;
    else if (actor.id === "owner" && !usedSeatIndices.has(1)) seatIdx = 1;
    if (seatIdx !== -1) {
      usedSeatIndices.add(seatIdx);
      assignments.set(actor.id, OFFICE_SEATS[seatIdx]!);
    }
  });

  let nextAvailable = 0;
  actors.forEach((actor) => {
    if (assignments.has(actor.id)) return;
    while (usedSeatIndices.has(nextAvailable % OFFICE_SEATS.length)) nextAvailable++;
    const idx = nextAvailable % OFFICE_SEATS.length;
    usedSeatIndices.add(idx);
    nextAvailable++;
    assignments.set(actor.id, OFFICE_SEATS[idx]!);
  });

  return assignments;
}

// ==========================================
// PURE OFFICE AGENT SIMULATION
// ==========================================

export type AgentActivity = "desk" | "sofa" | "coffee" | "window" | "chat" | "errand" | "report" | "bar" | "meeting" | "walking";

export type OfficeSimAgent = {
  id: string;
  /** Background staff ignore the council and never report to the director. */
  staff: boolean;
  assignedDeskId: string;
  assignedMeetingSeatId: string;
  currentPointId: string;
  currentX: number;
  currentZ: number;
  activity: AgentActivity;
  /** Simulation clock (seconds) when the current activity began; -1 until the first step. */
  stateStartTime: number;
  stateDuration: number;
  /** Clock time of the last report visit, for the 3-minute cooldown. */
  lastReportAt: number;
  deskSeconds: number;
  walkingSeconds: number;
  sofaSeconds: number;
  coffeeSeconds: number;
  windowSeconds: number;
  chatSeconds: number;
  errandSeconds: number;
  meetingSeconds: number;
  reportSeconds: number;
  barSeconds: number;
};

const REPORT_COOLDOWN_SECONDS = 180;
const MAX_REPORTS_AT_ONCE = 2;

/**
 * Creates pure agent instances for the simulation. The owner gets the director's chair as home,
 * the receptionist the reception chair; the other actors and then the staff get one desk each, in order.
 */
export function createOfficeAgents(actorIds: string[], staffIds: string[] = []): OfficeSimAgent[] {
  const seats = assignOfficeSeats(actorIds.map((id) => ({ id })));
  const deskPoints = ALL_INTERACTION_POINTS.filter((p) => p.kind === "desk");
  let ambientIndex = 0;

  const make = (id: string, staff: boolean): OfficeSimAgent => {
    const home = id === OWNER_SEAT_ID
      ? POINTS_BY_ID.get(OWNER_HOME_POINT_ID)!
      : id === RECEPTIONIST_ID
      ? POINTS_BY_ID.get("pt_reception")!
      : deskPoints[ambientIndex++ % deskPoints.length]!;
    return {
      id,
      staff,
      assignedDeskId: home.id,
      assignedMeetingSeatId: staff ? "" : seats.get(id)!.pointId,
      currentPointId: home.id,
      currentX: home.x,
      currentZ: home.z,
      activity: "desk",
      stateStartTime: -1,
      stateDuration: 0,
      lastReportAt: -Infinity,
      deskSeconds: 0,
      walkingSeconds: 0,
      sofaSeconds: 0,
      coffeeSeconds: 0,
      windowSeconds: 0,
      chatSeconds: 0,
      errandSeconds: 0,
      meetingSeconds: 0,
      reportSeconds: 0,
      barSeconds: 0,
    };
  };

  return [...actorIds.map((id) => make(id, false)), ...staffIds.map((id) => make(id, true))];
}

function accumulateActivity(agent: OfficeSimAgent, dt: number): void {
  switch (agent.activity) {
    case "desk": agent.deskSeconds += dt; break;
    case "walking": agent.walkingSeconds += dt; break;
    case "sofa": agent.sofaSeconds += dt; break;
    case "coffee": agent.coffeeSeconds += dt; break;
    case "window": agent.windowSeconds += dt; break;
    case "chat": agent.chatSeconds += dt; break;
    case "errand": agent.errandSeconds += dt; break;
    case "report": agent.reportSeconds += dt; break;
    case "bar": agent.barSeconds += dt; break;
    case "meeting": agent.meetingSeconds += dt; break;
  }
}

function releasePoint(agent: OfficeSimAgent, reservations: Map<string, string>): void {
  if (reservations.get(agent.currentPointId) === agent.id) reservations.delete(agent.currentPointId);
}

function moveAgentTo(
  agent: OfficeSimAgent,
  reservations: Map<string, string>,
  pointId: string,
  activity: AgentActivity,
  now: number,
  duration: number
): void {
  const point = POINTS_BY_ID.get(pointId)!;
  reservations.set(pointId, agent.id);
  agent.currentPointId = pointId;
  agent.currentX = point.x;
  agent.currentZ = point.z;
  agent.activity = activity;
  agent.stateStartTime = now;
  agent.stateDuration = duration;
}

/** First free ambient point of the given kinds, or null. */
function pickFreePoint(
  kinds: InteractionPointKind[],
  reservations: Map<string, string>,
  rng: () => number
): InteractionPoint | null {
  const free = ALL_INTERACTION_POINTS.filter((p) => kinds.includes(p.kind) && !p.assignedTo && !reservations.has(p.id));
  if (free.length === 0) return null;
  // A conversation needs two: join someone who already stands at a chat spot
  const joining = free.filter((p) => p.kind === "chat" && ALL_INTERACTION_POINTS.some((o) => o.propId === p.propId && o.id !== p.id && reservations.has(o.id)));
  if (joining.length > 0) return joining[Math.min(joining.length - 1, Math.floor(rng() * joining.length))]!;
  return free[Math.min(free.length - 1, Math.floor(rng() * free.length))]!;
}

function reportsInProgress(reservations: Map<string, string>): number {
  let count = 0;
  for (const pointId of reservations.keys()) {
    if (POINTS_BY_ID.get(pointId)?.kind === "report") count++;
  }
  return count;
}

/**
 * Advances the pure office simulation by dt seconds with an injected clock and rng.
 * - Council active: every actor except the owner walks to its meeting chair; the owner stays home.
 * - Owner: the director's chair for 90–240 s, then 60 % stays, 25 % window (15–30 s), 15 % bar (20–40 s).
 * - Other actors: desk stints, then coffee 30 %, sofa 25 %, window 10 %, chat 15 %, errand 10 % (printer,
 *   server, bookshelf), report 10 %. A report visit needs the owner at home, a free report point,
 *   a 3-minute cooldown and at most two at once; staff take a second chat instead of reporting.
 * - Staff never join the council.
 */
export function stepOfficeSimulation(
  agents: OfficeSimAgent[],
  reservations: Map<string, string>,
  now: number,
  dt: number,
  rng: () => number,
  isCouncilActive: boolean
): void {
  const owner = agents.find((a) => a.id === OWNER_SEAT_ID);
  const ownerAtHome = !owner || owner.activity === "desk";

  for (const agent of agents) {
    accumulateActivity(agent, dt);

    if (agent.stateStartTime < 0) {
      // First step: start the stint at the home point, then apply the rules below in the same step
      agent.stateStartTime = now;
      // The first stint is staggered and may be short, so the floor comes alive soon after the page opens
      agent.stateDuration = agent.id === OWNER_SEAT_ID ? 90 + rng() * 150 : 10 + rng() * 150;
      reservations.set(agent.currentPointId, agent.id);
    }

    if (agent.id === OWNER_SEAT_ID) {
      stepOwner(agent, reservations, now, rng);
      continue;
    }

    if (isCouncilActive && !agent.staff) {
      if (agent.currentPointId !== agent.assignedMeetingSeatId) {
        releasePoint(agent, reservations);
        moveAgentTo(agent, reservations, agent.assignedMeetingSeatId, "meeting", now, 9999);
      }
      continue;
    }

    // A meeting ends as soon as the council does; any other activity runs its full duration.
    if (agent.activity !== "meeting" && now - agent.stateStartTime < agent.stateDuration) continue;
    stepAmbient(agent, reservations, now, rng, ownerAtHome);
  }
}

function stepOwner(agent: OfficeSimAgent, reservations: Map<string, string>, now: number, rng: () => number): void {
  if (now - agent.stateStartTime < agent.stateDuration) return;
  releasePoint(agent, reservations);

  if (agent.activity === "desk") {
    const roll = rng();
    if (roll < 0.25 + 0.35) {
      moveAgentTo(agent, reservations, OWNER_HOME_POINT_ID, "desk", now, 90 + rng() * 150);
    } else if (roll < 0.85) {
      moveAgentTo(agent, reservations, "pt_director_window", "window", now, 15 + rng() * 15);
    } else {
      moveAgentTo(agent, reservations, "pt_director_bar", "bar", now, 20 + rng() * 20);
    }
    return;
  }

  moveAgentTo(agent, reservations, OWNER_HOME_POINT_ID, "desk", now, 90 + rng() * 150);
}

function stepAmbient(
  agent: OfficeSimAgent,
  reservations: Map<string, string>,
  now: number,
  rng: () => number,
  ownerAtHome: boolean
): void {
  releasePoint(agent, reservations);

  if (agent.activity !== "desk") {
    // After a break, back to the own desk.
    moveAgentTo(agent, reservations, agent.assignedDeskId, "desk", now, 30 + rng() * 70);
    return;
  }

  const roll = rng();
  let picked: { pointId: string; activity: AgentActivity; duration: number } | null = null;

  if (roll < 0.3) {
    const point = pickFreePoint(["coffee", "water"], reservations, rng);
    if (point) picked = { pointId: point.id, activity: "coffee", duration: 20 + rng() * 20 };
  } else if (roll < 0.55) {
    const point = pickFreePoint(["sofa"], reservations, rng);
    if (point) picked = { pointId: point.id, activity: "sofa", duration: 40 + rng() * 50 };
  } else if (roll < 0.65) {
    const point = pickFreePoint(["window"], reservations, rng);
    if (point) picked = { pointId: point.id, activity: "window", duration: 15 + rng() * 15 };
  } else if (roll < 0.8 || (agent.staff && roll >= 0.9)) {
    const point = pickFreePoint(["chat"], reservations, rng);
    if (point) picked = { pointId: point.id, activity: "chat", duration: 20 + rng() * 25 };
  } else if (roll < 0.9) {
    const point = pickFreePoint(["printer", "server", "browse"], reservations, rng);
    if (point) picked = { pointId: point.id, activity: "errand", duration: 10 + rng() * 15 };
  } else if (ownerAtHome && now - agent.lastReportAt >= REPORT_COOLDOWN_SECONDS && reportsInProgress(reservations) < MAX_REPORTS_AT_ONCE) {
    const point = pickFreePoint(["report"], reservations, rng);
    if (point) {
      picked = { pointId: point.id, activity: "report", duration: 8 + rng() * 7 };
      agent.lastReportAt = now;
    }
  }

  if (picked) {
    moveAgentTo(agent, reservations, picked.pointId, picked.activity, now, picked.duration);
  } else {
    moveAgentTo(agent, reservations, agent.assignedDeskId, "desk", now, 30 + rng() * 70);
  }
}
