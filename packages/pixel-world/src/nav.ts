/** A walkable-area obstacle or boundary in world units (x/z plane). */
export type NavRect = { minX: number; maxX: number; minZ: number; maxZ: number };
export type NavPoint = { x: number; z: number };

export type NavGridOptions = {
  /** The walkable area; a point closer than `margin` to its edge is blocked. */
  bounds: NavRect;
  /** Walls, props, anything people walk around. Taken once; the grid does not follow later changes. */
  obstacles: readonly NavRect[];
  /** A* cell size. Default 0.5. */
  step?: number;
  /** How far a body reaches past its centre point: points this close to an obstacle are blocked. Default 0.15. */
  margin?: number;
  /** The same for the straight-line checks that skip the search and smooth a path. Default 0.08. */
  segmentMargin?: number;
};

export type NavGrid = {
  /** Is the world point blocked by the bounds or an obstacle (within `margin`)? */
  isBlocked: (x: number, z: number, margin?: number) => boolean;
  /** Does the straight line cross a blocked point? */
  isSegmentBlocked: (x1: number, z1: number, x2: number, z2: number, margin?: number) => boolean;
  /** A* over the grid, string-pulled; waypoints end at the target. A blocked start or target snaps to a free cell within 3 cells. */
  findPath: (start: NavPoint, target: NavPoint) => NavPoint[];
};

/** Obstacles are filed into square buckets, so a point query tests only the few rectangles near it, not all of them. */
const BUCKET = 2;

/**
 * Builds the nav grid once from the bounds and the obstacle rectangles. Point queries are exact (any margin);
 * the A* cells are blocked from the default margin when first needed.
 */
export function createNavGrid(options: NavGridOptions): NavGrid {
  const { bounds } = options;
  const step = options.step ?? 0.5;
  const defaultMargin = options.margin ?? 0.15;
  const segmentMargin = options.segmentMargin ?? 0.08;

  const buckets = new Map<number, NavRect[]>();
  const bucketKey = (bx: number, bz: number) => bx * 65536 + bz;
  for (const r of options.obstacles) {
    for (let bx = Math.floor(r.minX / BUCKET); bx <= Math.floor(r.maxX / BUCKET); bx++) {
      for (let bz = Math.floor(r.minZ / BUCKET); bz <= Math.floor(r.maxZ / BUCKET); bz++) {
        const key = bucketKey(bx, bz);
        const list = buckets.get(key);
        if (list) list.push(r);
        else buckets.set(key, [r]);
      }
    }
  }

  const isBlocked = (x: number, z: number, margin = defaultMargin): boolean => {
    if (x < bounds.minX + margin || x > bounds.maxX - margin || z < bounds.minZ + margin || z > bounds.maxZ - margin) return true;
    for (let bx = Math.floor((x - margin) / BUCKET); bx <= Math.floor((x + margin) / BUCKET); bx++) {
      for (let bz = Math.floor((z - margin) / BUCKET); bz <= Math.floor((z + margin) / BUCKET); bz++) {
        const list = buckets.get(bucketKey(bx, bz));
        if (!list) continue;
        for (const r of list) {
          if (x >= r.minX - margin && x <= r.maxX + margin && z >= r.minZ - margin && z <= r.maxZ + margin) return true;
        }
      }
    }
    return false;
  };

  const isSegmentBlocked = (x1: number, z1: number, x2: number, z2: number, margin = segmentMargin): boolean => {
    const dist = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(3, Math.ceil(dist / 0.18));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (isBlocked(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t, margin)) return true;
    }
    return false;
  };

  const cellsW = Math.round((bounds.maxX - bounds.minX) / step) + 1;
  const cellsH = Math.round((bounds.maxZ - bounds.minZ) / step) + 1;
  const toGridX = (x: number) => Math.max(0, Math.min(cellsW - 1, Math.round((x - bounds.minX) / step)));
  const toGridZ = (z: number) => Math.max(0, Math.min(cellsH - 1, Math.round((z - bounds.minZ) / step)));
  const toWorldX = (gx: number) => bounds.minX + gx * step;
  const toWorldZ = (gz: number) => bounds.minZ + gz * step;

  // Blocked cells, computed on the first path search and reused by every one after it
  let blockedCells: Uint8Array | null = null;
  const cells = (): Uint8Array => {
    if (!blockedCells) {
      blockedCells = new Uint8Array(cellsW * cellsH);
      for (let gz = 0; gz < cellsH; gz++) {
        for (let gx = 0; gx < cellsW; gx++) blockedCells[gz * cellsW + gx] = isBlocked(toWorldX(gx), toWorldZ(gz)) ? 1 : 0;
      }
    }
    return blockedCells;
  };

  const DIRS = [
    { dx: 1, dz: 0, cost: 1 },
    { dx: -1, dz: 0, cost: 1 },
    { dx: 0, dz: 1, cost: 1 },
    { dx: 0, dz: -1, cost: 1 },
    { dx: 1, dz: 1, cost: 1.414 },
    { dx: -1, dz: 1, cost: 1.414 },
    { dx: 1, dz: -1, cost: 1.414 },
    { dx: -1, dz: -1, cost: 1.414 },
  ];

  const findPath = (start: NavPoint, target: NavPoint): NavPoint[] => {
    if (!isSegmentBlocked(start.x, start.z, target.x, target.z)) return [{ x: target.x, z: target.z }];

    const blocked = cells();
    const isCellBlocked = (gx: number, gz: number) => blocked[gz * cellsW + gx] === 1;

    const findFreeCell = (gx: number, gz: number) => {
      if (!isCellBlocked(gx, gz)) return { gx, gz };
      let bestDist = Infinity;
      let best = { gx, gz };
      for (let r = 1; r <= 3; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nx >= cellsW || nz < 0 || nz >= cellsH || isCellBlocked(nx, nz)) continue;
            const d = Math.hypot(dx, dz);
            if (d < bestDist) {
              bestDist = d;
              best = { gx: nx, gz: nz };
            }
          }
        }
        if (bestDist < Infinity) break;
      }
      return best;
    };

    const actualStart = findFreeCell(toGridX(start.x), toGridZ(start.z));
    const actualTarget = findFreeCell(toGridX(target.x), toGridZ(target.z));
    const cellKey = (gx: number, gz: number) => gz * cellsW + gx;
    const startKey = cellKey(actualStart.gx, actualStart.gz);
    const targetKey = cellKey(actualTarget.gx, actualTarget.gz);

    type Node = { gx: number; gz: number; g: number; f: number };
    // A Map keeps insertion order, so ties between equal costs resolve the same way on every run
    const openSet = new Map<number, Node>();
    const closed = new Uint8Array(cellsW * cellsH);
    const cameFrom = new Int32Array(cellsW * cellsH).fill(-1);

    const h = (gx: number, gz: number) => Math.hypot(toWorldX(gx) - toWorldX(actualTarget.gx), toWorldZ(gz) - toWorldZ(actualTarget.gz));
    openSet.set(startKey, { gx: actualStart.gx, gz: actualStart.gz, g: 0, f: h(actualStart.gx, actualStart.gz) });

    let found = false;
    let maxIters = 8000;
    while (openSet.size > 0 && maxIters-- > 0) {
      let current: Node | null = null;
      for (const node of openSet.values()) {
        if (!current || node.f < current.f) current = node;
      }
      if (!current) break;

      const currentKey = cellKey(current.gx, current.gz);
      if (currentKey === targetKey) {
        found = true;
        break;
      }
      openSet.delete(currentKey);
      closed[currentKey] = 1;

      for (const d of DIRS) {
        const ngx = current.gx + d.dx;
        const ngz = current.gz + d.dz;
        if (ngx < 0 || ngx >= cellsW || ngz < 0 || ngz >= cellsH) continue;
        const nKey = cellKey(ngx, ngz);
        if (closed[nKey] === 1 || isCellBlocked(ngx, ngz)) continue;
        // Diagonal steps need both orthogonal neighbours free, so paths never clip a corner
        if (d.dx !== 0 && d.dz !== 0 && (isCellBlocked(current.gx + d.dx, current.gz) || isCellBlocked(current.gx, current.gz + d.dz))) continue;

        const tentativeG = current.g + d.cost * step;
        const existing = openSet.get(nKey);
        if (!existing || tentativeG < existing.g) {
          cameFrom[nKey] = currentKey;
          openSet.set(nKey, { gx: ngx, gz: ngz, g: tentativeG, f: tentativeG + h(ngx, ngz) });
        }
      }
    }

    const rawPoints: NavPoint[] = [];
    if (found) {
      let key = targetKey;
      while (key !== startKey) {
        rawPoints.push({ x: toWorldX(key % cellsW), z: toWorldZ(Math.floor(key / cellsW)) });
        const prev = cameFrom[key]!;
        if (prev < 0) break;
        key = prev;
      }
      rawPoints.reverse();
    }

    // String pulling: skip waypoints that are visible from the current one
    const full = [{ x: start.x, z: start.z }, ...rawPoints, { x: target.x, z: target.z }];
    const smoothed: NavPoint[] = [];
    let currIdx = 0;
    while (currIdx < full.length - 1) {
      let farthest = currIdx + 1;
      for (let next = full.length - 1; next > currIdx + 1; next--) {
        if (!isSegmentBlocked(full[currIdx]!.x, full[currIdx]!.z, full[next]!.x, full[next]!.z)) {
          farthest = next;
          break;
        }
      }
      smoothed.push(full[farthest]!);
      currIdx = farthest;
    }
    return smoothed.length > 0 ? smoothed : [{ x: target.x, z: target.z }];
  };

  return { isBlocked, isSegmentBlocked, findPath };
}
