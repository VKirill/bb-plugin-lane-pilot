import { GraphBuilder } from "./graph";
import type { Block, BlockKind, Plot, PlotSlot, Vec, WorldMap } from "./types";

/**
 * The starter city: 3 x 3 blocks around the office, streets between them (4 tiles of road and a 1 tile sidewalk on each
 * side), eight plots in every ordinary block. Everything is generated from constants, so the map is the same for every seed
 * (the seed decides what is built on the plots, see world.ts).
 */
export const COLS = 3;
export const ROWS = 3;
export const BLOCK_W = 56;
export const BLOCK_D = 40;
export const MAP_W = COLS * BLOCK_W;
export const MAP_D = ROWS * BLOCK_D;
export const MAP_X0 = -MAP_W / 2;
export const MAP_Z0 = -MAP_D / 2;
const RING = 2.5;
const PLOT_INSET = 3;
const PLOT_COLS = 4;

const LAYOUT: BlockKind[][] = [
  ["residential", "commercial", "residential"],
  ["free", "office", "industrial"],
  ["free", "park", "free"],
];

/** Office points of interest, from the office layout (grid coords 0..40 x 0..20; world = grid - (20, 10)). */
const og = (gx: number, gz: number): Vec => ({ x: gx - 20, z: gz - 10 });
const OFFICE_POINTS: Array<{ at: Vec; kind: string; clip: string }> = [
  ...[[15, 2.4], [17, 2.4], [15, 5.6], [17, 5.6], [21, 2.4], [23, 2.4], [21, 5.6], [23, 5.6]].map(([x, z]) => ({ at: og(x!, z!), kind: "desk", clip: "typing" })),
  ...[[1.3, 5], [10.7, 5], [3, 3.3], [5, 3.3], [7, 3.3], [9, 3.3], [3, 6.7], [5, 6.7], [7, 6.7], [9, 6.7]].map(([x, z]) => ({ at: og(x!, z!), kind: "seat", clip: "sitting_table" })),
  ...[[15.5, 14.4], [17.5, 14.4]].map(([x, z]) => ({ at: og(x!, z!), kind: "coffee", clip: "drinking" })),
  { at: og(20, 14.6), kind: "water", clip: "drinking" },
  ...[[14.5, 17.7], [16, 17.7], [17.5, 17.7]].map(([x, z]) => ({ at: og(x!, z!), kind: "stool", clip: "sitting_sofa" })),
  ...[[3.5, 17.6], [5.5, 17.6], [9.2, 16.5]].map(([x, z]) => ({ at: og(x!, z!), kind: "sofa", clip: "sitting_sofa" })),
  ...[[18.6, 8], [19.6, 8], [34.6, 15], [35.6, 15]].map(([x, z]) => ({ at: og(x!, z!), kind: "chat", clip: "chatting" })),
  { at: og(1, 16.5), kind: "window", clip: "window_gaze" },
];
const OFFICE_DOOR_X = 13;
const OFFICE_HALL = og(30, 13);

export function generateMap(): WorldMap {
  const sw = new GraphBuilder();
  const rb = new GraphBuilder();
  const blocks: Block[] = [];
  const plots: Record<string, Plot> = {};

  // Blocks and their sidewalk rings (the doors are added to the ring edges below).
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    const x0 = MAP_X0 + i * BLOCK_W, z0 = MAP_Z0 + j * BLOCK_D;
    blocks.push({ id: `b${i}_${j}`, i, j, x0, z0, x1: x0 + BLOCK_W, z1: z0 + BLOCK_D, kind: LAYOUT[j]![i]!, corners: [] });
  }

  const northDoors = new Map<string, number[]>();
  const southDoors = new Map<string, number[]>();
  const roadStops = new Map<string, Set<number>>();
  const addStop = (line: number, seg: number, x: number) => {
    const key = `${line}:${seg}`;
    (roadStops.get(key) ?? roadStops.set(key, new Set()).get(key)!).add(x);
  };

  for (const block of blocks) {
    const rx0 = block.x0 + PLOT_INSET, rx1 = block.x1 - PLOT_INSET, rz0 = block.z0 + PLOT_INSET, rz1 = block.z1 - PLOT_INSET;
    const north = block.z0 + RING, south = block.z1 - RING;
    block.corners = [sw.node(block.x0 + RING, north), sw.node(block.x1 - RING, north), sw.node(block.x1 - RING, south), sw.node(block.x0 + RING, south)];
    const nDoors: number[] = [], sDoors: number[] = [];
    northDoors.set(block.id, nDoors); southDoors.set(block.id, sDoors);

    const makePlot = (index: number, spec: { x0: number; z0: number; x1: number; z1: number; side: "n" | "s"; doorX: number; slots: Array<{ at: Vec; kind?: string; clip?: string }>; entryX?: number; entryZ?: number; hall?: Vec }) => {
      const id = `${block.id}p${index}`;
      const ringZ = spec.side === "n" ? north : south;
      const doorNode = sw.node(spec.doorX, ringZ);
      (spec.side === "n" ? nDoors : sDoors).push(doorNode);
      const entryX = spec.entryX ?? spec.doorX;
      const entryZ = spec.entryZ ?? (spec.side === "n" ? spec.z0 + 1.5 : spec.z1 - 1.5);
      const entryNode = sw.node(entryX, entryZ);
      sw.edge(doorNode, entryNode, "enter");
      const hub = spec.hall ? sw.node(spec.hall.x, spec.hall.z) : entryNode;
      if (spec.hall) sw.edge(entryNode, hub, "interior");
      const slots: PlotSlot[] = spec.slots.map((s) => {
        const node = sw.node(s.at.x, s.at.z);
        sw.edge(hub, node, "interior");
        return { x: s.at.x, z: s.at.z, node, ...(s.kind ? { kind: s.kind } : {}), ...(s.clip ? { clip: s.clip } : {}) };
      });
      const roadZ = spec.side === "n" ? block.z0 : block.z1;
      addStop(spec.side === "n" ? block.j : block.j + 1, block.i, spec.doorX);
      plots[id] = { id, blockId: block.id, zone: block.kind, x0: spec.x0, z0: spec.z0, x1: spec.x1, z1: spec.z1, side: spec.side, doorNode, entryNode, roadNode: -1, slots };
      // roadNode is resolved after the road graph exists; remember where it lies.
      (plots[id] as Plot & { _road?: Vec })._road = { x: spec.doorX, z: roadZ };
    };

    if (block.kind === "office") {
      makePlot(0, { x0: -20, z0: -10, x1: 20, z1: 10, side: "s", doorX: OFFICE_DOOR_X, entryZ: 9.5, hall: OFFICE_HALL, slots: OFFICE_POINTS.map((p) => ({ at: p.at, kind: p.kind, clip: p.clip })) });
    } else if (block.kind === "park") {
      const cx = (rx0 + rx1) / 2;
      const slots = [-18, -9, 9, 18].flatMap((dx) => [{ at: { x: cx + dx, z: rz0 + 9 }, kind: "bench", clip: "sitting_sofa" }, { at: { x: cx + dx, z: rz1 - 9 }, kind: "stroll", clip: "walk" }]);
      makePlot(0, { x0: rx0, z0: rz0, x1: rx1, z1: rz1, side: "s", doorX: cx, entryZ: rz1 - 1.5, slots });
    } else {
      const pw = (rx1 - rx0) / PLOT_COLS, pd = (rz1 - rz0) / 2;
      let index = 0;
      for (let r = 0; r < 2; r++) for (let c = 0; c < PLOT_COLS; c++) {
        const cx0 = rx0 + c * pw, cz0 = rz0 + r * pd;
        const x0 = cx0 + 1, x1 = cx0 + pw - 1, z0 = cz0 + 1, z1 = cz0 + pd - 1;
        const cx = cx0 + pw / 2;
        const side = r === 0 ? "n" : "s";
        const dir = side === "n" ? 1 : -1;
        const entryZ = side === "n" ? z0 + 1.5 : z1 - 1.5;
        const a = entryZ + dir * 3, b = entryZ + dir * 7;
        makePlot(index++, { x0, z0, x1, z1, side, doorX: cx, slots: [{ at: { x: cx - 2.5, z: a } }, { at: { x: cx + 2.5, z: a } }, { at: { x: cx - 2.5, z: b } }, { at: { x: cx + 2.5, z: b } }] });
      }
    }
  }

  // Ring edges: corners and doors in order along each side.
  for (const block of blocks) {
    const [nw, ne, se, sw0] = block.corners as [number, number, number, number];
    const byX = (ids: number[]) => [...ids].sort((p, q) => sw.graph.nodes[p]!.x - sw.graph.nodes[q]!.x);
    const chain = (ids: number[]) => { for (let k = 1; k < ids.length; k++) sw.edge(ids[k - 1]!, ids[k]!, "walk"); };
    chain([nw, ...byX(northDoors.get(block.id)!), ne]);
    chain([sw0, ...byX(southDoors.get(block.id)!), se]);
    sw.edge(nw, sw0, "walk");
    sw.edge(ne, se, "walk");
  }
  // Crossings over the streets between neighbouring blocks.
  const at = (i: number, j: number) => blocks[j * COLS + i]!;
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    const b = at(i, j);
    if (i + 1 < COLS) { const o = at(i + 1, j); sw.edge(b.corners[1]!, o.corners[0]!, "cross"); sw.edge(b.corners[2]!, o.corners[3]!, "cross"); }
    if (j + 1 < ROWS) { const o = at(i, j + 1); sw.edge(b.corners[3]!, o.corners[0]!, "cross"); sw.edge(b.corners[2]!, o.corners[1]!, "cross"); }
  }

  // Road graph: intersections, with a stop in front of every plot door on the horizontal streets.
  const crossing = (i: number, j: number) => rb.node(MAP_X0 + i * BLOCK_W, MAP_Z0 + j * BLOCK_D);
  for (let j = 0; j <= ROWS; j++) for (let i = 0; i < COLS; i++) {
    const z = MAP_Z0 + j * BLOCK_D;
    const xs = [...(roadStops.get(`${j}:${i}`) ?? [])].sort((p, q) => p - q);
    const ids = [crossing(i, j), ...xs.map((x) => rb.node(x, z)), crossing(i + 1, j)];
    for (let k = 1; k < ids.length; k++) rb.edge(ids[k - 1]!, ids[k]!, "road");
  }
  for (let i = 0; i <= COLS; i++) for (let j = 0; j < ROWS; j++) rb.edge(crossing(i, j), crossing(i, j + 1), "road");
  for (const plot of Object.values(plots)) {
    const where = (plot as Plot & { _road?: Vec })._road!;
    plot.roadNode = rb.node(where.x, where.z);
    delete (plot as Plot & { _road?: Vec })._road;
  }

  const grid = renderTiles(blocks, plots);
  return { grid, blocks, plots, sidewalk: sw.graph, road: rb.graph, officePlotId: "b1_1p0", depotPlotId: "b2_1p0" };
}

function renderTiles(blocks: Block[], plots: Record<string, Plot>): WorldMap["grid"] {
  const rows: string[] = [];
  const plotsByBlock = new Map<string, Plot[]>();
  for (const plot of Object.values(plots)) (plotsByBlock.get(plot.blockId) ?? plotsByBlock.set(plot.blockId, []).get(plot.blockId)!).push(plot);
  for (let tz = 0; tz < MAP_D; tz++) {
    let row = "";
    const z = MAP_Z0 + tz + 0.5;
    for (let tx = 0; tx < MAP_W; tx++) {
      const x = MAP_X0 + tx + 0.5;
      const edge = Math.min(distanceToLine(x - MAP_X0, BLOCK_W), distanceToLine(z - MAP_Z0, BLOCK_D));
      if (edge < 2) { row += "1"; continue; }
      if (edge < 3) { row += "2"; continue; }
      const block = blocks[Math.min(ROWS - 1, Math.floor((z - MAP_Z0) / BLOCK_D)) * COLS + Math.min(COLS - 1, Math.floor((x - MAP_X0) / BLOCK_W))]!;
      const inside = (plotsByBlock.get(block.id) ?? []).some((p) => x >= p.x0 && x < p.x1 && z >= p.z0 && z < p.z1);
      row += block.kind === "park" ? "5" : block.kind === "office" ? (inside ? "4" : "0") : inside ? "3" : "0";
    }
    rows.push(row);
  }
  return { w: MAP_W, d: MAP_D, x0: MAP_X0, z0: MAP_Z0, tiles: rows.join("") };
}

/** Distance from a coordinate (measured from the map's corner) to the nearest street centre line. */
function distanceToLine(offset: number, pitch: number): number {
  const m = offset % pitch;
  return Math.min(m, pitch - m);
}
