export type OfficeActivity = "speaking" | "arguing" | "waiting" | "idle";

export type OfficeActor = {
  id: string;
  label: string;
  color: string;
  activity: OfficeActivity;
  bubble?: string;
  facing?: string;
};

export type CouncilDetailLike = {
  id: string;
  state: string;
  speaking: string | null;
  speakingSince?: number | null;
  seats: Array<{ id: string; title: string }>;
  messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at?: number }>;
};

export type OfficeObstacle = {
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type OfficeSeat = {
  id: string;
  seatId: string;
  x: number;
  z: number;
  angle: number;
  speakX: number;
  speakZ: number;
};

export type OfficeSpot = {
  key: string;
  x: number;
  z: number;
  angle: number;
  action: "coffee" | "window" | "typing" | "bookshelf" | "plant";
};

export type OfficePose = {
  sitting: boolean;
  bodyY: number;
  headY: number;
  leftArmPitch: number;
  rightArmPitch: number;
  leftArmYaw: number;
  rightArmYaw: number;
  leftArmRoll: number;
  rightArmRoll: number;
  leftLegPitch: number;
  rightLegPitch: number;
  headPitch: number;
  headYaw: number;
  pointing: boolean;
  action?: string;
};

const SEAT_PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
  "#84cc16", // lime
  "#14b8a6", // teal
  "#6366f1", // indigo
];

const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);
const IDLE_TIMEOUT_MS = 20000;

export const OFFICE_OBSTACLES: OfficeObstacle[] = [
  // Central table: 4.4 x 2.2 at (0, 0)
  { name: "table", minX: -2.25, maxX: 2.25, minZ: -1.15, maxZ: 1.15 },
  // Desks
  { name: "desk1", minX: -4.45, maxX: -2.75, minZ: -3.05, maxZ: -1.95 },
  { name: "desk2", minX: -4.45, maxX: -2.75, minZ: 1.95, maxZ: 3.05 },
  { name: "desk3", minX: 2.75, maxX: 4.45, minZ: -3.05, maxZ: -1.95 },
  // Coffee counter: at (4.2, 3.8), size 1.4 x 1.6 -> x: [3.5, 4.9], z: [3.0, 4.6]
  { name: "coffee", minX: 3.45, maxX: 4.95, minZ: 2.95, maxZ: 4.65 },
  // Bookshelf: at (-4.2, -4.2), size 1.8 x 0.8 -> x: [-5.1, -3.3], z: [-4.6, -3.8]
  { name: "bookshelf", minX: -5.15, maxX: -3.25, minZ: -4.65, maxZ: -3.75 },
  // Plants
  { name: "plant1", minX: 3.7, maxX: 4.7, minZ: -4.7, maxZ: -3.7 },
  { name: "plant2", minX: -4.7, maxX: -3.7, minZ: 3.7, maxZ: 4.7 },
];

export const OFFICE_SEATS: OfficeSeat[] = [
  // West head (Chair)
  { id: "seat_chair", seatId: "chair", x: -2.6, z: 0, angle: Math.PI / 2, speakX: -2.5, speakZ: -0.6 },
  // East head (Owner)
  { id: "seat_owner", seatId: "owner", x: 2.6, z: 0, angle: -Math.PI / 2, speakX: 2.5, speakZ: 0.6 },
  // North side (facing south)
  { id: "seat_n1", seatId: "n1", x: -1.4, z: -1.6, angle: 0, speakX: -1.4, speakZ: -1.35 },
  { id: "seat_n2", seatId: "n2", x: 0, z: -1.6, angle: 0, speakX: 0, speakZ: -1.35 },
  { id: "seat_n3", seatId: "n3", x: 1.4, z: -1.6, angle: 0, speakX: 1.4, speakZ: -1.35 },
  // South side (facing north)
  { id: "seat_s1", seatId: "s1", x: -1.4, z: 1.6, angle: Math.PI, speakX: -1.4, speakZ: 1.35 },
  { id: "seat_s2", seatId: "s2", x: 0, z: 1.6, angle: Math.PI, speakX: 0, speakZ: 1.35 },
  { id: "seat_s3", seatId: "s3", x: 1.4, z: 1.6, angle: Math.PI, speakX: 1.4, speakZ: 1.35 },
];

export const OFFICE_SPOTS: Record<string, OfficeSpot> = {
  desk1: { key: "desk1", x: -3.6, z: -1.4, angle: -Math.PI / 2, action: "typing" },
  desk2: { key: "desk2", x: -3.6, z: 1.4, angle: -Math.PI / 2, action: "typing" },
  desk3: { key: "desk3", x: 3.6, z: -1.4, angle: Math.PI / 2, action: "typing" },
  coffee: { key: "coffee", x: 2.9, z: 3.8, angle: Math.PI / 4, action: "coffee" },
  bookshelf: { key: "bookshelf", x: -3.8, z: -3.2, angle: -Math.PI / 4, action: "bookshelf" },
  window: { key: "window", x: -4.0, z: 0, angle: -Math.PI / 2, action: "window" },
  plant1: { key: "plant1", x: 3.5, z: -3.5, angle: Math.PI / 4, action: "plant" },
  plant2: { key: "plant2", x: -3.5, z: 3.5, angle: -3 * Math.PI / 4, action: "plant" },
};

export function seatColor(id: string, seatsOrIndex?: Array<{ id: string }> | number): string {
  if (id === "owner") return "#e11d48"; // rose
  if (id === "chair") return "#64748b"; // slate
  if (id === "moderator") return "#71717a"; // zinc

  if (typeof seatsOrIndex === "number") {
    return SEAT_PALETTE[Math.abs(seatsOrIndex) % SEAT_PALETTE.length]!;
  }

  if (Array.isArray(seatsOrIndex)) {
    const regularSeats = seatsOrIndex.filter(
      (s) => s.id !== "owner" && s.id !== "chair" && s.id !== "moderator"
    );
    const idx = regularSeats.findIndex((s) => s.id === id);
    if (idx !== -1) {
      return SEAT_PALETTE[idx % SEAT_PALETTE.length]!;
    }
  }

  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return SEAT_PALETTE[hash % SEAT_PALETTE.length]!;
}

export function assignSeatColors(seats: Array<{ id: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of seats) {
    map.set(s.id, seatColor(s.id, seats));
  }
  return map;
}

export function stripMarkdown(text: string): string {
  return text
    // Fenced code blocks
    .replace(/```[\s\S]*?```/g, "")
    // Inline code
    .replace(/`([^`]+)`/g, "$1")
    // Images
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Links
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Headers
    .replace(/^#{1,6}\s+/gm, "")
    // Blockquotes
    .replace(/^>\s+/gm, "")
    // Bold / italic
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // Strikethrough
    .replace(/~~(.*?)~~/g, "$1")
    // Bullet / numbered lists
    .replace(/^[\*\-+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    // Collapse whitespace
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatBubbleText(text: string, max = 80): string {
  const plain = stripMarkdown(text);
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trimEnd()}…`;
}

export function isFloorBlocked(x: number, z: number, margin = 0): boolean {
  if (x < -5.0 + margin || x > 5.0 - margin || z < -5.0 + margin || z > 5.0 - margin) {
    return true;
  }
  for (const obs of OFFICE_OBSTACLES) {
    if (
      x >= obs.minX - margin &&
      x <= obs.maxX + margin &&
      z >= obs.minZ - margin &&
      z <= obs.maxZ + margin
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a direct line between two points crosses any obstacle.
 */
export function isLineSegmentBlocked(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  margin = 0
): boolean {
  const dist = Math.hypot(x2 - x1, z2 - z1);
  const steps = Math.max(2, Math.ceil(dist / 0.1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t;
    const pz = z1 + (z2 - z1) * t;
    if (isFloorBlocked(px, pz, margin)) {
      return true;
    }
  }
  return false;
}

/**
 * Coarse grid A* pathfinding on the office floor to navigate around furniture.
 */
export function findOfficePath(
  start: { x: number; z: number },
  target: { x: number; z: number }
): Array<{ x: number; z: number }> {
  // If direct line is clear, return direct destination
  if (!isLineSegmentBlocked(start.x, start.z, target.x, target.z)) {
    return [{ x: target.x, z: target.z }];
  }

  // Grid bounds: -4.8 to 4.8 with 0.4 step
  const STEP = 0.4;
  const MIN_COORD = -4.8;
  const MAX_COORD = 4.8;
  const GRID_SIZE = Math.round((MAX_COORD - MIN_COORD) / STEP) + 1;

  const toGridX = (x: number) =>
    Math.max(0, Math.min(GRID_SIZE - 1, Math.round((x - MIN_COORD) / STEP)));
  const toGridZ = (z: number) =>
    Math.max(0, Math.min(GRID_SIZE - 1, Math.round((z - MIN_COORD) / STEP)));
  const toWorldX = (gx: number) => MIN_COORD + gx * STEP;
  const toWorldZ = (gz: number) => MIN_COORD + gz * STEP;

  const startGx = toGridX(start.x);
  const startGz = toGridZ(start.z);
  const targetGx = toGridX(target.x);
  const targetGz = toGridZ(target.z);

  // If start is blocked, find nearest unblocked neighbor
  let actualStartGx = startGx;
  let actualStartGz = startGz;
  if (isFloorBlocked(toWorldX(actualStartGx), toWorldZ(actualStartGz))) {
    let bestDist = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const nx = startGx + dx;
        const nz = startGz + dz;
        if (nx >= 0 && nx < GRID_SIZE && nz >= 0 && nz < GRID_SIZE) {
          if (!isFloorBlocked(toWorldX(nx), toWorldZ(nz))) {
            const d = Math.hypot(dx, dz);
            if (d < bestDist) {
              bestDist = d;
              actualStartGx = nx;
              actualStartGz = nz;
            }
          }
        }
      }
    }
  }

  // If target is blocked, find nearest unblocked neighbor
  let actualTargetGx = targetGx;
  let actualTargetGz = targetGz;
  if (isFloorBlocked(toWorldX(actualTargetGx), toWorldZ(actualTargetGz))) {
    let bestDist = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const nx = targetGx + dx;
        const nz = targetGz + dz;
        if (nx >= 0 && nx < GRID_SIZE && nz >= 0 && nz < GRID_SIZE) {
          if (!isFloorBlocked(toWorldX(nx), toWorldZ(nz))) {
            const d = Math.hypot(dx, dz);
            if (d < bestDist) {
              bestDist = d;
              actualTargetGx = nx;
              actualTargetGz = nz;
            }
          }
        }
      }
    }
  }

  const key = (gx: number, gz: number) => `${gx},${gz}`;
  const startKey = key(actualStartGx, actualStartGz);
  const targetKey = key(actualTargetGx, actualTargetGz);

  type Node = { gx: number; gz: number; g: number; f: number };
  const openSet = new Map<string, Node>();
  const closedSet = new Set<string>();
  const cameFrom = new Map<string, { gx: number; gz: number }>();

  const h = (gx: number, gz: number) =>
    Math.hypot(toWorldX(gx) - toWorldX(actualTargetGx), toWorldZ(gz) - toWorldZ(actualTargetGz));

  openSet.set(startKey, {
    gx: actualStartGx,
    gz: actualStartGz,
    g: 0,
    f: h(actualStartGx, actualStartGz),
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
  let maxIters = 800;

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
      if (ngx < 0 || ngx >= GRID_SIZE || ngz < 0 || ngz >= GRID_SIZE) continue;

      const nKey = key(ngx, ngz);
      if (closedSet.has(nKey)) continue;

      const wx = toWorldX(ngx);
      const wz = toWorldZ(ngz);
      if (isFloorBlocked(wx, wz)) continue;

      // For diagonals, ensure adjacent orthogonal cells are clear
      if (d.dx !== 0 && d.dz !== 0) {
        if (
          isFloorBlocked(toWorldX(current.gx + d.dx), toWorldZ(current.gz)) ||
          isFloorBlocked(toWorldX(current.gx), toWorldZ(current.gz + d.dz))
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

  const rawPath: Array<{ x: number; z: number }> = [];
  if (found) {
    let currKey = targetKey;
    while (currKey !== startKey) {
      const [gxStr, gzStr] = currKey.split(",");
      const gx = Number(gxStr);
      const gz = Number(gzStr);
      rawPath.push({ x: toWorldX(gx), z: toWorldZ(gz) });
      const prev = cameFrom.get(currKey);
      if (!prev) break;
      currKey = key(prev.gx, prev.gz);
    }
    rawPath.reverse();
  }

  // Combine full path for smoothing: start -> raw grid points -> target
  const fullPath: Array<{ x: number; z: number }> = [
    { x: start.x, z: start.z },
    ...rawPath,
  ];
  if (
    fullPath.length === 1 ||
    Math.hypot(
      fullPath[fullPath.length - 1]!.x - target.x,
      fullPath[fullPath.length - 1]!.z - target.z
    ) > 0.05
  ) {
    fullPath.push({ x: target.x, z: target.z });
  }

  // String pulling / line-of-sight shortcutting
  const smoothedPath: Array<{ x: number; z: number }> = [];
  let currIdx = 0;
  while (currIdx < fullPath.length - 1) {
    let farthest = currIdx + 1;
    for (let next = fullPath.length - 1; next > currIdx + 1; next--) {
      if (
        !isLineSegmentBlocked(
          fullPath[currIdx]!.x,
          fullPath[currIdx]!.z,
          fullPath[next]!.x,
          fullPath[next]!.z
        )
      ) {
        farthest = next;
        break;
      }
    }
    smoothedPath.push(fullPath[farthest]!);
    currIdx = farthest;
  }

  return smoothedPath.length > 0 ? smoothedPath : [{ x: target.x, z: target.z }];
}

/**
 * Moves one step towards a target at bounded speed, never teleporting.
 */
export function walkStep(
  current: { x: number; z: number },
  target: { x: number; z: number },
  speedOrMaxDist: number,
  dt?: number
): { x: number; z: number; reached: boolean; heading: number } {
  const maxStep = dt !== undefined ? speedOrMaxDist * dt : speedOrMaxDist;
  const dx = target.x - current.x;
  const dz = target.z - current.z;
  const dist = Math.hypot(dx, dz);
  const heading = dist > 1e-5 ? Math.atan2(dx, dz) : 0;

  if (dist <= maxStep || dist < 1e-5) {
    return {
      x: target.x,
      z: target.z,
      reached: true,
      heading,
    };
  }

  const ratio = maxStep / dist;
  return {
    x: current.x + dx * ratio,
    z: current.z + dz * ratio,
    reached: false,
    heading,
  };
}

/**
 * Assigns distinct chairs at the meeting table to each actor.
 * Guarantees uniqueness: no two actors share a seat.
 */
export function assignOfficeSeats(
  actors: Array<{ id: string }>
): Map<string, OfficeSeat> {
  const assignments = new Map<string, OfficeSeat>();
  const usedSeatIndices = new Set<number>();

  // Deterministically prioritize "chair" and "owner"
  actors.forEach((actor) => {
    let seatIdx = -1;
    if (actor.id === "chair" && !usedSeatIndices.has(0)) {
      seatIdx = 0;
    } else if (actor.id === "owner" && !usedSeatIndices.has(1)) {
      seatIdx = 1;
    }

    if (seatIdx !== -1) {
      usedSeatIndices.add(seatIdx);
      assignments.set(actor.id, OFFICE_SEATS[seatIdx]!);
    }
  });

  // Assign remaining seats
  let nextAvailable = 0;
  actors.forEach((actor) => {
    if (assignments.has(actor.id)) return;
    while (usedSeatIndices.has(nextAvailable % OFFICE_SEATS.length)) {
      nextAvailable++;
    }
    const idx = nextAvailable % OFFICE_SEATS.length;
    usedSeatIndices.add(idx);
    nextAvailable++;
    assignments.set(actor.id, OFFICE_SEATS[idx]!);
  });

  return assignments;
}

/**
 * Selects an idle spot for an actor, ensuring two actors never share a spot.
 */
export function chooseIdleSpot(
  occupiedSpots: Set<string>,
  rng: () => number,
  currentSpot?: string | null
): string | null {
  const allSpotKeys = Object.keys(OFFICE_SPOTS);
  const available = allSpotKeys.filter(
    (key) => !occupiedSpots.has(key) && key !== currentSpot
  );

  if (available.length === 0) {
    const unoccupied = allSpotKeys.filter((key) => !occupiedSpots.has(key));
    if (unoccupied.length === 0) return null;
    const idx = Math.floor(rng() * unoccupied.length);
    return unoccupied[idx] ?? null;
  }

  const idx = Math.floor(rng() * available.length);
  return available[idx] ?? null;
}

/**
 * Calculates joint angles and body positioning for an actor's current activity.
 */
export function getOfficePose(
  activity: OfficeActivity,
  options?: {
    tick?: number;
    isWalking?: boolean;
    sittingProgress?: number;
    action?: string;
  }
): OfficePose {
  const tick = options?.tick ?? 0;
  const isWalking = options?.isWalking ?? false;
  const sittingProgress = isWalking
    ? 0
    : (options?.sittingProgress ?? (activity === "waiting" ? 1 : 0));
  const action = options?.action;

  // Base standing pose values
  let bodyY = 0.88;
  let headY = 1.35;
  let leftArmPitch = 0;
  let rightArmPitch = 0;
  let leftArmYaw = 0;
  let rightArmYaw = 0;
  let leftArmRoll = 0;
  let rightArmRoll = 0;
  let leftLegPitch = 0;
  let rightLegPitch = 0;
  let headPitch = 0;
  let headYaw = 0;
  let pointing = false;

  if (isWalking) {
    const legSwing = Math.sin(tick * 8) * 0.55;
    leftLegPitch = legSwing;
    rightLegPitch = -legSwing;
    leftArmPitch = -legSwing * 0.6;
    rightArmPitch = legSwing * 0.6;
    bodyY = 0.88 + Math.abs(Math.sin(tick * 8)) * 0.04;
    headY = 1.35 + Math.abs(Math.sin(tick * 8)) * 0.04;
  } else if (activity === "speaking") {
    const gesture1 = Math.sin(tick * 4) * 0.35;
    const gesture2 = Math.cos(tick * 3) * 0.25;
    leftArmPitch = -0.5 + gesture1;
    rightArmPitch = 0.2 + gesture2;
    leftArmRoll = 0.2;
    rightArmRoll = -0.2;
    headPitch = Math.sin(tick * 4) * 0.08;
    bodyY = 0.88 + Math.sin(tick * 4) * 0.02;
    headY = 1.35 + Math.sin(tick * 4) * 0.03;
  } else if (activity === "arguing") {
    pointing = true;
    rightArmPitch = -Math.PI / 2 + Math.sin(tick * 3) * 0.08;
    rightArmRoll = -0.1;
    leftArmPitch = 0.35 + Math.sin(tick * 4) * 0.2;
    headPitch = Math.sin(tick * 5) * 0.1;
    bodyY = 0.88;
    headY = 1.35;
  } else if (activity === "waiting") {
    headPitch = Math.sin(tick * 1.5) * 0.03;
    leftArmPitch = 0.35;
    rightArmPitch = 0.35;
  } else if (activity === "idle") {
    if (action === "typing") {
      leftArmPitch = -0.55 + Math.sin(tick * 10) * 0.15;
      rightArmPitch = -0.55 - Math.sin(tick * 10) * 0.15;
      headPitch = 0.2;
    } else if (action === "coffee") {
      rightArmPitch = -1.1 + Math.sin(tick * 2) * 0.06;
      rightArmYaw = 0.45;
      leftArmPitch = 0.1;
    } else if (action === "bookshelf") {
      rightArmPitch = -1.8 + Math.sin(tick * 2) * 0.1;
      headPitch = -0.25;
    } else if (action === "window") {
      leftArmPitch = 0.2;
      rightArmPitch = 0.2;
      leftArmYaw = -0.2;
      rightArmYaw = 0.2;
    } else {
      leftArmPitch = Math.sin(tick * 2) * 0.08;
      rightArmPitch = -Math.sin(tick * 2) * 0.08;
    }
  }

  if (sittingProgress > 0) {
    const sitRatio = Math.max(0, Math.min(1, sittingProgress));
    bodyY = bodyY * (1 - sitRatio) + 0.70 * sitRatio;
    headY = headY * (1 - sitRatio) + 1.20 * sitRatio;
    leftLegPitch = leftLegPitch * (1 - sitRatio) + (Math.PI / 2) * sitRatio;
    rightLegPitch = rightLegPitch * (1 - sitRatio) + (Math.PI / 2) * sitRatio;
  }

  return {
    sitting: sittingProgress > 0.5,
    bodyY,
    headY,
    leftArmPitch,
    rightArmPitch,
    leftArmYaw,
    rightArmYaw,
    leftArmRoll,
    rightArmRoll,
    leftLegPitch,
    rightLegPitch,
    headPitch,
    headYaw,
    pointing,
    action,
  };
}

export function nextWanderTarget(rng: () => number, current: string | null, points: string[]): string {
  if (points.length === 0) return "";
  const candidates = current ? points.filter((p) => p !== current) : points;
  if (candidates.length === 0) return current ?? points[0]!;
  const idx = Math.floor(rng() * candidates.length);
  return candidates[Math.max(0, Math.min(candidates.length - 1, idx))]!;
}

function truncateBubble(text: string, max = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function deriveOfficeActors(
  detail: CouncilDetailLike,
  cursor: number | null,
  now: number
): OfficeActor[] {
  const visibleMessages = cursor === null
    ? detail.messages
    : detail.messages.filter((m) => m.seq <= cursor);

  // Replay cursor mode
  if (cursor !== null) {
    const activeMsg = visibleMessages.find((m) => m.seq === cursor) ?? null;
    const activeSpeakerId = activeMsg?.seatId ?? null;

    // Previous speaker to face if active message is reply
    let previousSpeakerId: string | undefined;
    if (activeMsg && activeMsg.kind === "reply") {
      const activeIdx = visibleMessages.findIndex((m) => m.seq === cursor);
      for (let i = activeIdx - 1; i >= 0; i--) {
        const prev = visibleMessages[i]!;
        if (prev.seatId !== activeSpeakerId) {
          previousSpeakerId = prev.seatId;
          break;
        }
      }
    }

    const hasOwnerMsg = visibleMessages.some((m) => m.seatId === "owner");
    const actors: OfficeActor[] = [];

    // Chair
    actors.push({
      id: "chair",
      label: "Chair",
      color: seatColor("chair", detail.seats),
      activity: "chair" === activeSpeakerId
        ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
        : (activeSpeakerId ? "waiting" : "idle"),
      ...(activeSpeakerId === "chair" && activeMsg ? { bubble: formatBubbleText(activeMsg.text) } : {}),
      ...(activeSpeakerId === "chair" && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
    });

    // Owner (only if spoke up to cursor)
    if (hasOwnerMsg) {
      actors.push({
        id: "owner",
        label: "Owner",
        color: seatColor("owner", detail.seats),
        activity: "owner" === activeSpeakerId
          ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
          : (activeSpeakerId ? "waiting" : "idle"),
        ...(activeSpeakerId === "owner" && activeMsg ? { bubble: formatBubbleText(activeMsg.text) } : {}),
        ...(activeSpeakerId === "owner" && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
      });
    }

    // Regular seats
    for (const seat of detail.seats) {
      const isSpeaking = seat.id === activeSpeakerId;
      actors.push({
        id: seat.id,
        label: seat.title,
        color: seatColor(seat.id, detail.seats),
        activity: isSpeaking
          ? (activeMsg?.kind === "reply" ? "arguing" : "speaking")
          : (activeSpeakerId ? "waiting" : "idle"),
        ...(isSpeaking && activeMsg ? { bubble: formatBubbleText(activeMsg.text) } : {}),
        ...(isSpeaking && activeMsg?.kind === "reply" && previousSpeakerId ? { facing: previousSpeakerId } : {}),
      });
    }

    return actors;
  }

  // Live mode
  const isTerminal = TERMINAL_STATES.has(detail.state);
  const liveSpeaker = detail.speaking;
  const isIdleTimeout = Boolean(
    !liveSpeaker &&
    detail.speakingSince &&
    now - detail.speakingSince > IDLE_TIMEOUT_MS
  );
  const isWandering = isTerminal || isIdleTimeout || (!liveSpeaker && !detail.speakingSince);

  const hasOwnerMsg = detail.messages.some((m) => m.seatId === "owner");
  const latestMsg = detail.messages.length > 0 ? detail.messages[detail.messages.length - 1] : null;

  const getLiveBubble = (id: string): string => {
    for (let i = detail.messages.length - 1; i >= 0; i--) {
      if (detail.messages[i]!.seatId === id) {
        return formatBubbleText(detail.messages[i]!.text);
      }
    }
    return "…";
  };

  let replyFacing: string | undefined;
  if (liveSpeaker && latestMsg && latestMsg.seatId === liveSpeaker && latestMsg.kind === "reply") {
    for (let i = detail.messages.length - 2; i >= 0; i--) {
      if (detail.messages[i]!.seatId !== liveSpeaker) {
        replyFacing = detail.messages[i]!.seatId;
        break;
      }
    }
  }

  const actors: OfficeActor[] = [];

  // Chair
  const chairIsSpeaking = liveSpeaker === "chair";
  actors.push({
    id: "chair",
    label: "Chair",
    color: seatColor("chair", detail.seats),
    activity: chairIsSpeaking
      ? (latestMsg?.kind === "reply" && latestMsg.seatId === "chair" ? "arguing" : "speaking")
      : (isWandering ? "idle" : "waiting"),
    ...(chairIsSpeaking ? { bubble: getLiveBubble("chair") } : {}),
    ...(chairIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
  });

  // Owner (only if owner sent a message)
  if (hasOwnerMsg) {
    const ownerIsSpeaking = liveSpeaker === "owner";
    actors.push({
      id: "owner",
      label: "Owner",
      color: seatColor("owner", detail.seats),
      activity: ownerIsSpeaking
        ? (latestMsg?.kind === "reply" && latestMsg.seatId === "owner" ? "arguing" : "speaking")
        : (isWandering ? "idle" : "waiting"),
      ...(ownerIsSpeaking ? { bubble: getLiveBubble("owner") } : {}),
      ...(ownerIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
    });
  }

  // Seats
  for (const seat of detail.seats) {
    const seatIsSpeaking = liveSpeaker === seat.id;
    actors.push({
      id: seat.id,
      label: seat.title,
      color: seatColor(seat.id, detail.seats),
      activity: seatIsSpeaking
        ? (latestMsg?.kind === "reply" && latestMsg.seatId === seat.id ? "arguing" : "speaking")
        : (isWandering ? "idle" : "waiting"),
      ...(seatIsSpeaking ? { bubble: getLiveBubble(seat.id) } : {}),
      ...(seatIsSpeaking && replyFacing ? { facing: replyFacing } : {}),
    });
  }

  return actors;
}
