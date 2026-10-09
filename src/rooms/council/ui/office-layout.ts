export type ZoneKind =
  | "meeting"
  | "open_space"
  | "kitchen"
  | "lounge"
  | "server_room"
  | "entrance";

export type PropKind =
  | "meeting_table"
  | "meeting_chair"
  | "workstation_desk"
  | "workstation_chair"
  | "coffee_counter"
  | "water_cooler"
  | "sofa"
  | "coffee_table"
  | "server_rack"
  | "printer"
  | "plant"
  | "window_ledge"
  | "whiteboard"
  | "cabinet";

export type InteractionPointKind =
  | "meeting_seat"
  | "meeting_speak"
  | "desk"
  | "coffee"
  | "water"
  | "sofa"
  | "window"
  | "chat"
  | "printer";

export type InteractionPose =
  | "sitting_table"
  | "speaking"
  | "arguing"
  | "typing"
  | "drinking"
  | "sitting_sofa"
  | "window_gaze"
  | "chatting";

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
  assignedTo?: string; // dedicated seatId
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

// Floor dimensions: 20 x 14
export const FLOOR_BOUNDS = {
  minX: -10.0,
  maxX: 10.0,
  minZ: -7.0,
  maxZ: 7.0,
};

// Low interior divider walls with doorways connecting rooms
export const OFFICE_WALLS: WallSegment[] = [
  // Outer boundary walls (cutaway diorama back walls)
  { id: "wall_back_left", minX: -10.0, maxX: -9.5, minZ: -7.0, maxZ: 7.0, height: 3.8 },
  { id: "wall_back_right", minX: -10.0, maxX: 10.0, minZ: -7.0, maxZ: -6.5, height: 3.8 },

  // Interior wall: Meeting room East divider (x ~ -2.0) with doorway at z in [-1.5, 0.2]
  { id: "wall_meeting_e1", minX: -2.3, maxX: -1.9, minZ: -6.5, maxZ: -2.0, height: 1.4, isInterior: true },
  { id: "wall_meeting_e2", minX: -2.3, maxX: -1.9, minZ: 0.8, maxZ: 1.5, height: 1.4, isInterior: true },

  // Interior wall: Meeting room South divider (between meeting and lounge) with doorway
  { id: "wall_meeting_s1", minX: -9.5, maxX: -5.5, minZ: 1.2, maxZ: 1.6, height: 1.4, isInterior: true },
  { id: "wall_meeting_s2", minX: -3.5, maxX: -1.9, minZ: 1.2, maxZ: 1.6, height: 1.4, isInterior: true },

  // Interior wall: Lounge East divider (between lounge and kitchen) with doorway
  { id: "wall_lounge_e1", minX: -2.3, maxX: -1.9, minZ: 1.6, maxZ: 3.2, height: 1.4, isInterior: true },
  { id: "wall_lounge_e2", minX: -2.3, maxX: -1.9, minZ: 5.2, maxZ: 6.8, height: 1.4, isInterior: true },

  // Interior wall: Server room divider (top right x: [5.2, 9.5], z: [-6.5, -2.0]) with doorway
  { id: "wall_server_w", minX: 4.8, maxX: 5.2, minZ: -6.5, maxZ: -3.5, height: 1.4, isInterior: true },
  { id: "wall_server_s", minX: 5.2, maxX: 9.5, minZ: -2.2, maxZ: -1.8, height: 1.4, isInterior: true },

  // Interior wall: Kitchen East divider (between kitchen and entrance) with doorway
  { id: "wall_kitchen_e", minX: 4.8, maxX: 5.2, minZ: 2.5, maxZ: 6.8, height: 1.4, isInterior: true },
];

// All props with their exact bounding box and interaction points
export const OFFICE_PROPS: PropFootprint[] = [
  // 1. Meeting Room (x: [-9.5, -2.0], z: [-6.5, 1.2])
  {
    id: "prop_meeting_table",
    kind: "meeting_table",
    minX: -6.8,
    maxX: -3.2,
    minZ: -3.4,
    maxZ: -1.4,
    zone: "meeting",
    interactionPoints: [
      // Speaking spot beside table
      { id: "pt_meeting_speak", propId: "prop_meeting_table", kind: "meeting_speak", x: -5.0, z: -0.8, approachAngle: 0, pose: "speaking", capacity: 1, zone: "meeting" },
    ],
  },
  // Meeting room chairs (8 chairs)
  ...[
    // West & East heads
    { id: "chair_m_chair", seatId: "chair", x: -7.4, z: -2.4, angle: Math.PI / 2 },
    { id: "chair_m_owner", seatId: "owner", x: -2.6, z: -2.4, angle: -Math.PI / 2 },
    // North side
    { id: "chair_m_n1", seatId: "n1", x: -6.0, z: -4.0, angle: 0 },
    { id: "chair_m_n2", seatId: "n2", x: -5.0, z: -4.0, angle: 0 },
    { id: "chair_m_n3", seatId: "n3", x: -4.0, z: -4.0, angle: 0 },
    // South side
    { id: "chair_m_s1", seatId: "s1", x: -6.0, z: -0.8, angle: Math.PI },
    { id: "chair_m_s2", seatId: "s2", x: -5.0, z: -0.8, angle: Math.PI },
    { id: "chair_m_s3", seatId: "s3", x: -4.0, z: -0.8, angle: Math.PI },
  ].map((c) => ({
    id: `prop_${c.id}`,
    kind: "meeting_chair" as PropKind,
    minX: c.x - 0.28,
    maxX: c.x + 0.28,
    minZ: c.z - 0.28,
    maxZ: c.z + 0.28,
    zone: "meeting" as ZoneKind,
    interactionPoints: [
      {
        id: `pt_${c.id}`,
        propId: `prop_${c.id}`,
        kind: "meeting_seat" as InteractionPointKind,
        x: c.x,
        z: c.z,
        approachAngle: c.angle,
        pose: "sitting_table" as InteractionPose,
        capacity: 1,
        zone: "meeting" as ZoneKind,
        assignedTo: c.seatId,
      },
    ],
  })),

  // Whiteboard in meeting room on north wall
  {
    id: "prop_whiteboard",
    kind: "whiteboard",
    minX: -6.2,
    maxX: -3.8,
    minZ: -6.5,
    maxZ: -6.2,
    zone: "meeting",
    interactionPoints: [],
  },

  // 2. Open Space Workstations (8 individual desks for council directors)
  ...[
    // Row 1 (North)
    { id: "desk_1", seatId: "chair", x: -0.5, z: -5.0, angle: -Math.PI / 2 },
    { id: "desk_2", seatId: "owner", x: -0.5, z: -3.2, angle: -Math.PI / 2 },
    { id: "desk_3", seatId: "product", x: -0.5, z: -1.4, angle: -Math.PI / 2 },
    { id: "desk_4", seatId: "skeptic", x: 2.2, z: -5.0, angle: Math.PI / 2 },
    { id: "desk_5", seatId: "growth", x: 2.2, z: -3.2, angle: Math.PI / 2 },
    { id: "desk_6", seatId: "finance", x: 2.2, z: -1.4, angle: Math.PI / 2 },
    { id: "desk_7", seatId: "design", x: 3.6, z: -5.0, angle: Math.PI / 2 },
    { id: "desk_8", seatId: "engineer", x: 3.6, z: -3.2, angle: Math.PI / 2 },
  ].map((d) => ({
    id: `prop_${d.id}`,
    kind: "workstation_desk" as PropKind,
    minX: d.x - 0.35,
    maxX: d.x + 0.35,
    minZ: d.z - 0.55,
    maxZ: d.z + 0.55,
    zone: "open_space" as ZoneKind,
    interactionPoints: [
      {
        id: `pt_${d.id}`,
        propId: `prop_${d.id}`,
        kind: "desk" as InteractionPointKind,
        x: d.x + (d.angle === -Math.PI / 2 ? 0.65 : -0.65),
        z: d.z,
        approachAngle: d.angle,
        pose: "typing" as InteractionPose,
        capacity: 1,
        zone: "open_space" as ZoneKind,
        assignedTo: d.seatId,
      },
    ],
  })),

  // 3. Kitchen & Coffee (x: [-1.9, 4.8], z: [1.6, 6.8])
  {
    id: "prop_coffee_counter",
    kind: "coffee_counter",
    minX: -0.8,
    maxX: 2.2,
    minZ: 5.2,
    maxZ: 6.6,
    zone: "kitchen",
    interactionPoints: [
      { id: "pt_coffee_1", propId: "prop_coffee_counter", kind: "coffee", x: 0.2, z: 4.6, approachAngle: 0, pose: "drinking", capacity: 1, zone: "kitchen" },
      { id: "pt_coffee_2", propId: "prop_coffee_counter", kind: "coffee", x: 1.4, z: 4.6, approachAngle: 0, pose: "drinking", capacity: 1, zone: "kitchen" },
    ],
  },
  {
    id: "prop_water_cooler",
    kind: "water_cooler",
    minX: 3.2,
    maxX: 4.2,
    minZ: 5.4,
    maxZ: 6.4,
    zone: "kitchen",
    interactionPoints: [
      { id: "pt_water", propId: "prop_water_cooler", kind: "water", x: 3.7, z: 4.8, approachAngle: 0, pose: "drinking", capacity: 1, zone: "kitchen" },
    ],
  },

  // 4. Lounge (x: [-9.5, -2.0], z: [1.6, 6.8])
  {
    id: "prop_sofa",
    kind: "sofa",
    minX: -7.5,
    maxX: -4.5,
    minZ: 4.2,
    maxZ: 5.6,
    zone: "lounge",
    interactionPoints: [
      { id: "pt_sofa_1", propId: "prop_sofa", kind: "sofa", x: -6.5, z: 3.6, approachAngle: 0, pose: "sitting_sofa", capacity: 1, zone: "lounge" },
      { id: "pt_sofa_2", propId: "prop_sofa", kind: "sofa", x: -5.5, z: 3.6, approachAngle: 0, pose: "sitting_sofa", capacity: 1, zone: "lounge" },
    ],
  },
  {
    id: "prop_window_lounge",
    kind: "window_ledge",
    minX: -9.5,
    maxX: -9.0,
    minZ: 2.8,
    maxZ: 4.4,
    zone: "lounge",
    interactionPoints: [
      { id: "pt_window_lounge", propId: "prop_window_lounge", kind: "window", x: -8.4, z: 3.6, approachAngle: -Math.PI / 2, pose: "window_gaze", capacity: 1, zone: "lounge" },
    ],
  },

  // 5. Server & Printer Room (x: [5.2, 9.5], z: [-6.5, -2.0])
  {
    id: "prop_server_rack",
    kind: "server_rack",
    minX: 6.4,
    maxX: 8.8,
    minZ: -6.4,
    maxZ: -5.2,
    zone: "server_room",
    interactionPoints: [],
  },
  {
    id: "prop_printer",
    kind: "printer",
    minX: 6.2,
    maxX: 7.6,
    minZ: -3.8,
    maxZ: -2.6,
    zone: "server_room",
    interactionPoints: [
      { id: "pt_printer", propId: "prop_printer", kind: "printer", x: 6.9, z: -4.4, approachAngle: 0, pose: "typing", capacity: 1, zone: "server_room" },
    ],
  },

  // 6. Entrance area & hallway plants
  {
    id: "prop_plant_entrance",
    kind: "plant",
    minX: 6.8,
    maxX: 7.8,
    minZ: 1.2,
    maxZ: 2.2,
    zone: "entrance",
    interactionPoints: [
      { id: "pt_chat_entrance", propId: "prop_plant_entrance", kind: "chat", x: 6.4, z: 2.6, approachAngle: -Math.PI / 4, pose: "chatting", capacity: 2, zone: "entrance" },
    ],
  },
  {
    id: "prop_plant_meeting",
    kind: "plant",
    minX: -8.8,
    maxX: -7.8,
    minZ: -6.2,
    maxZ: -5.2,
    zone: "meeting",
    interactionPoints: [],
  },
];

// All interaction points extracted from props
export const ALL_INTERACTION_POINTS: InteractionPoint[] = OFFICE_PROPS.flatMap(
  (p) => p.interactionPoints
);

/**
 * Checks if a coordinate is blocked by walls, props or outer boundary
 */
export function isOfficeFloorBlocked(x: number, z: number, margin = 0.15): boolean {
  // Outer diorama floor boundary
  if (
    x < FLOOR_BOUNDS.minX + margin ||
    x > FLOOR_BOUNDS.maxX - margin ||
    z < FLOOR_BOUNDS.minZ + margin ||
    z > FLOOR_BOUNDS.maxZ - margin
  ) {
    return true;
  }

  // Wall segments
  for (const w of OFFICE_WALLS) {
    if (
      x >= w.minX - margin &&
      x <= w.maxX + margin &&
      z >= w.minZ - margin &&
      z <= w.maxZ + margin
    ) {
      return true;
    }
  }

  // Props (furniture footprints that block walking)
  for (const p of OFFICE_PROPS) {
    // Chairs are sitting destinations, not impassable obstacles
    if (p.kind === "meeting_chair" || p.kind === "workstation_chair") continue;
    if (
      x >= p.minX - margin &&
      x <= p.maxX + margin &&
      z >= p.minZ - margin &&
      z <= p.maxZ + margin
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a line segment crosses any wall or prop
 */
export function isOfficeSegmentBlocked(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  margin = 0.08
): boolean {
  const dist = Math.hypot(x2 - x1, z2 - z1);
  const steps = Math.max(3, Math.ceil(dist / 0.18));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t;
    const pz = z1 + (z2 - z1) * t;
    if (isOfficeFloorBlocked(px, pz, margin)) {
      return true;
    }
  }
  return false;
}

/**
 * A* grid pathfinder across the multi-room office floor
 */
export function findOfficeFloorPath(
  start: { x: number; z: number },
  target: { x: number; z: number }
): Array<{ x: number; z: number }> {
  if (!isOfficeSegmentBlocked(start.x, start.z, target.x, target.z)) {
    return [{ x: target.x, z: target.z }];
  }

  const STEP = 0.4;
  const MIN_X = FLOOR_BOUNDS.minX;
  const MAX_X = FLOOR_BOUNDS.maxX;
  const MIN_Z = FLOOR_BOUNDS.minZ;
  const MAX_Z = FLOOR_BOUNDS.maxZ;
  const GRID_W = Math.round((MAX_X - MIN_X) / STEP) + 1;
  const GRID_H = Math.round((MAX_Z - MIN_Z) / STEP) + 1;

  const toGridX = (x: number) =>
    Math.max(0, Math.min(GRID_W - 1, Math.round((x - MIN_X) / STEP)));
  const toGridZ = (z: number) =>
    Math.max(0, Math.min(GRID_H - 1, Math.round((z - MIN_Z) / STEP)));
  const toWorldX = (gx: number) => MIN_X + gx * STEP;
  const toWorldZ = (gz: number) => MIN_Z + gz * STEP;

  let startGx = toGridX(start.x);
  let startGz = toGridZ(start.z);
  let targetGx = toGridX(target.x);
  let targetGz = toGridZ(target.z);

  // If start or target grid cells are blocked, snap to closest unblocked neighbor
  const findFreeNeighbor = (gx: number, gz: number) => {
    if (!isOfficeFloorBlocked(toWorldX(gx), toWorldZ(gz))) return { gx, gz };
    let bestDist = Infinity;
    let best = { gx, gz };
    for (let r = 1; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx >= 0 && nx < GRID_W && nz >= 0 && nz < GRID_H) {
            if (!isOfficeFloorBlocked(toWorldX(nx), toWorldZ(nz))) {
              const d = Math.hypot(dx, dz);
              if (d < bestDist) {
                bestDist = d;
                best = { gx: nx, gz: nz };
              }
            }
          }
        }
      }
      if (bestDist < Infinity) break;
    }
    return best;
  };

  const actualStart = findFreeNeighbor(startGx, startGz);
  const actualTarget = findFreeNeighbor(targetGx, targetGz);

  const key = (gx: number, gz: number) => `${gx},${gz}`;
  const startKey = key(actualStart.gx, actualStart.gz);
  const targetKey = key(actualTarget.gx, actualTarget.gz);

  type Node = { gx: number; gz: number; g: number; f: number };
  const openSet = new Map<string, Node>();
  const closedSet = new Set<string>();
  const cameFrom = new Map<string, { gx: number; gz: number }>();

  const h = (gx: number, gz: number) =>
    Math.hypot(toWorldX(gx) - toWorldX(actualTarget.gx), toWorldZ(gz) - toWorldZ(actualTarget.gz));

  openSet.set(startKey, {
    gx: actualStart.gx,
    gz: actualStart.gz,
    g: 0,
    f: h(actualStart.gx, actualStart.gz),
  });

  const dirs = [
    { dx: 1, dz: 0, cost: 1 },
    { dx: -1, dz: 0, cost: 1 },
    { dx: 0, dz: 1, cost: 1 },
    { dx: 0, dz: -1, cost: 1 },
    { dx: 1, dz: 1, cost: 1.414 },
    { dx: -1, dz: 1, cost: 1.414 },
    { dx: 1, dz: -1, cost: 1.414 },
    { dx: -1, dz: -1, cost: 1.414 },
  ];

  let found = false;
  let maxIters = 1200;

  while (openSet.size > 0 && maxIters-- > 0) {
    let current: Node | null = null;
    for (const node of openSet.values()) {
      if (!current || node.f < current.f) {
        current = node;
      }
    }
    if (!current) break;

    const currentKey = key(current.gx, current.gz);
    if (currentKey === targetKey) {
      found = true;
      break;
    }

    openSet.delete(currentKey);
    closedSet.add(currentKey);

    for (const d of dirs) {
      const ngx = current.gx + d.dx;
      const ngz = current.gz + d.dz;
      if (ngx < 0 || ngx >= GRID_W || ngz < 0 || ngz >= GRID_H) continue;

      const nKey = key(ngx, ngz);
      if (closedSet.has(nKey)) continue;

      const wx = toWorldX(ngx);
      const wz = toWorldZ(ngz);
      if (isOfficeFloorBlocked(wx, wz)) continue;

      // Diagonals: check adjacent orthogonals
      if (d.dx !== 0 && d.dz !== 0) {
        if (
          isOfficeFloorBlocked(toWorldX(current.gx + d.dx), toWorldZ(current.gz)) ||
          isOfficeFloorBlocked(toWorldX(current.gx), toWorldZ(current.gz + d.dz))
        ) {
          continue;
        }
      }

      const tentativeG = current.g + d.cost * STEP;
      const existing = openSet.get(nKey);
      if (!existing || tentativeG < existing.g) {
        cameFrom.set(nKey, { gx: current.gx, gz: current.gz });
        openSet.set(nKey, {
          gx: ngx,
          gz: ngz,
          g: tentativeG,
          f: tentativeG + h(ngx, ngz),
        });
      }
    }
  }

  const rawPoints: Array<{ x: number; z: number }> = [];
  if (found) {
    let currKey = targetKey;
    while (currKey !== startKey) {
      const [gxStr, gzStr] = currKey.split(",");
      rawPoints.push({ x: toWorldX(Number(gxStr)), z: toWorldZ(Number(gzStr)) });
      const prev = cameFrom.get(currKey);
      if (!prev) break;
      currKey = key(prev.gx, prev.gz);
    }
    rawPoints.reverse();
  }

  // String pulling shortcutting
  const full = [{ x: start.x, z: start.z }, ...rawPoints, { x: target.x, z: target.z }];
  const smoothed: Array<{ x: number; z: number }> = [];
  let currIdx = 0;
  while (currIdx < full.length - 1) {
    let farthest = currIdx + 1;
    for (let next = full.length - 1; next > currIdx + 1; next--) {
      if (!isOfficeSegmentBlocked(full[currIdx]!.x, full[currIdx]!.z, full[next]!.x, full[next]!.z)) {
        farthest = next;
        break;
      }
    }
    smoothed.push(full[farthest]!);
    currIdx = farthest;
  }

  return smoothed.length > 0 ? smoothed : [{ x: target.x, z: target.z }];
}

// ==========================================
// PURE OFFICE AGENT SIMULATION
// ==========================================

export type AgentActivity =
  | "desk"
  | "sofa"
  | "coffee"
  | "window"
  | "chat"
  | "meeting"
  | "walking";

export type OfficeSimAgent = {
  id: string;
  assignedDeskId: string;
  assignedMeetingSeatId: string;
  currentPointId: string;
  currentX: number;
  currentZ: number;
  activity: AgentActivity;
  stateStartTime: number;
  stateDuration: number;
  // Accumulated time in seconds
  deskSeconds: number;
  walkingSeconds: number;
  sofaSeconds: number;
  coffeeSeconds: number;
  windowSeconds: number;
  chatSeconds: number;
  meetingSeconds: number;
};

/**
 * Creates pure agent instances for simulation and scene runtime
 */
export function createOfficeAgents(actorIds: string[]): OfficeSimAgent[] {
  const deskPoints = ALL_INTERACTION_POINTS.filter((p) => p.kind === "desk");
  const meetingSeats = ALL_INTERACTION_POINTS.filter((p) => p.kind === "meeting_seat");

  return actorIds.map((id, index) => {
    // Dedicated unique desk
    const assignedDesk = deskPoints[index % deskPoints.length]!;
    // Dedicated unique meeting seat
    const assignedSeat = meetingSeats[index % meetingSeats.length]!;

    return {
      id,
      assignedDeskId: assignedDesk.id,
      assignedMeetingSeatId: assignedSeat.id,
      currentPointId: assignedDesk.id,
      currentX: assignedDesk.x,
      currentZ: assignedDesk.z,
      activity: "desk",
      stateStartTime: 0,
      stateDuration: 120, // starts working at desk
      deskSeconds: 0,
      walkingSeconds: 0,
      sofaSeconds: 0,
      coffeeSeconds: 0,
      windowSeconds: 0,
      chatSeconds: 0,
      meetingSeconds: 0,
    };
  });
}

/**
 * Advances the pure office agent simulation by dt seconds with injected clock and rng.
 * Enforces:
 * - One user per point (reservations)
 * - Long realistic activity durations:
 *   desk 60-180 s, sofa 40-90 s, coffee 20-40 s, window 15-30 s, chat 20-45 s
 * - Council gathering override
 * - Purposeful transitions: ≥50% desk time, <20% walking
 */
export function stepOfficeSimulation(
  agents: OfficeSimAgent[],
  reservations: Map<string, string>, // pointId -> agentId
  now: number,
  dt: number,
  rng: () => number,
  isCouncilActive: boolean
): void {
  for (const agent of agents) {
    // Accumulate time in current activity
    if (agent.activity === "desk") agent.deskSeconds += dt;
    else if (agent.activity === "walking") agent.walkingSeconds += dt;
    else if (agent.activity === "sofa") agent.sofaSeconds += dt;
    else if (agent.activity === "coffee") agent.coffeeSeconds += dt;
    else if (agent.activity === "window") agent.windowSeconds += dt;
    else if (agent.activity === "chat") agent.chatSeconds += dt;
    else if (agent.activity === "meeting") agent.meetingSeconds += dt;

    // Council duty override: all characters gather at their meeting seats
    if (isCouncilActive) {
      if (agent.currentPointId !== agent.assignedMeetingSeatId) {
        // Release previous point
        if (reservations.get(agent.currentPointId) === agent.id) {
          reservations.delete(agent.currentPointId);
        }
        reservations.set(agent.assignedMeetingSeatId, agent.id);
        agent.currentPointId = agent.assignedMeetingSeatId;
        agent.activity = "meeting";
        agent.stateStartTime = now;
        agent.stateDuration = 9999;
      }
      continue;
    }

    // Normal office life
    const elapsed = now - agent.stateStartTime;
    if (elapsed >= agent.stateDuration || agent.activity === "meeting") {
      // Release old reservation
      if (reservations.get(agent.currentPointId) === agent.id) {
        reservations.delete(agent.currentPointId);
      }

      // Pick next purposeful activity with weights favoring desk (to guarantee >=50% desk time)
      let nextActivity: AgentActivity = "desk";
      let nextPointId = agent.assignedDeskId;
      let nextDuration = 60 + Math.floor(rng() * 120); // 60-180s

      if (agent.activity === "desk") {
        // After working, take a short purposeful break
        const roll = rng();
        if (roll < 0.35) {
          // Coffee break
          const coffeePts = ALL_INTERACTION_POINTS.filter(
            (p) => p.kind === "coffee" && !reservations.has(p.id)
          );
          if (coffeePts.length > 0) {
            const picked = coffeePts[Math.floor(rng() * coffeePts.length)]!;
            nextActivity = "coffee";
            nextPointId = picked.id;
            nextDuration = 20 + Math.floor(rng() * 20); // 20-40s
          }
        } else if (roll < 0.65) {
          // Sofa lounge break
          const sofaPts = ALL_INTERACTION_POINTS.filter(
            (p) => p.kind === "sofa" && !reservations.has(p.id)
          );
          if (sofaPts.length > 0) {
            const picked = sofaPts[Math.floor(rng() * sofaPts.length)]!;
            nextActivity = "sofa";
            nextPointId = picked.id;
            nextDuration = 40 + Math.floor(rng() * 50); // 40-90s
          }
        } else if (roll < 0.85) {
          // Window gaze
          const winPts = ALL_INTERACTION_POINTS.filter(
            (p) => p.kind === "window" && !reservations.has(p.id)
          );
          if (winPts.length > 0) {
            const picked = winPts[Math.floor(rng() * winPts.length)]!;
            nextActivity = "window";
            nextPointId = picked.id;
            nextDuration = 15 + Math.floor(rng() * 15); // 15-30s
          }
        } else {
          // Hallway chat
          const chatPts = ALL_INTERACTION_POINTS.filter(
            (p) => p.kind === "chat" && (!reservations.has(p.id) || reservations.get(p.id) !== agent.id)
          );
          if (chatPts.length > 0) {
            const picked = chatPts[Math.floor(rng() * chatPts.length)]!;
            nextActivity = "chat";
            nextPointId = picked.id;
            nextDuration = 20 + Math.floor(rng() * 25); // 20-45s
          }
        }
      } else {
        // After break, head straight back to their own desk!
        nextActivity = "desk";
        nextPointId = agent.assignedDeskId;
        nextDuration = 80 + Math.floor(rng() * 100); // 80-180s
      }

      // Reserve point
      reservations.set(nextPointId, agent.id);
      agent.currentPointId = nextPointId;
      agent.activity = nextActivity;
      agent.stateStartTime = now;
      agent.stateDuration = nextDuration;
    }
  }
}
