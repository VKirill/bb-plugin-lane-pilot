import { nextId } from "./rng";
import { emit, type Sim } from "./sim";
import type { Building, BuildingKind, Citizen, Poi, WorldState } from "./types";

/** Which plot slot serves which purpose in a building: `[slot, point kind, clip]`. Office and park slots carry their own. */
const TEMPLATES: Record<BuildingKind, Array<[number, string, string]>> = {
  house: [[0, "bed", "sleep"], [1, "table", "eat"], [2, "sofa", "sitting_sofa"]],
  cafe: [[0, "work", "operating"], [1, "table", "eat"], [2, "table", "eat"], [3, "chat", "chatting"]],
  shop: [[0, "work", "operating"], [1, "shop", "shop"], [2, "shop", "shop"], [3, "shop", "shop"]],
  depot: [[0, "work", "operating"], [1, "work", "operating"], [2, "work", "operating"], [3, "work", "operating"]],
  workshop: [[0, "work", "operating"], [1, "work", "operating"], [2, "work", "operating"], [3, "work", "operating"]],
  warehouse: [],
  office: [],
  park: [],
};

export const BLUEPRINT_KINDS: BuildingKind[] = ["house", "cafe", "shop", "workshop"];

export function addBuilding(sim: Sim, input: { plotId: string; kind: BuildingKind; name: string; districtId?: string | null; siteId?: string | null }): Building {
  const s = sim.s;
  const plot = s.map.plots[input.plotId]!;
  const id = nextId(s, "bd");
  const poiIds: string[] = [];
  const fromSlots = input.kind === "office" || input.kind === "park";
  const entries: Array<[number, string, string]> = fromSlots ? plot.slots.map((slot, i) => [i, slot.kind ?? "spot", slot.clip ?? "idle"] as [number, string, string]) : TEMPLATES[input.kind];
  for (const [slotIndex, kind, clip] of entries) {
    const slot = plot.slots[slotIndex];
    if (!slot) continue;
    const poi: Poi = { id: `${id}.${poiIds.length}`, buildingId: id, kind, x: slot.x, z: slot.z, node: slot.node, clip };
    s.pois[poi.id] = poi;
    poiIds.push(poi.id);
  }
  const building: Building = { id, plotId: input.plotId, kind: input.kind, name: input.name, districtId: input.districtId ?? null, poiIds, siteId: input.siteId ?? null, openedAt: s.time };
  s.buildings[id] = building;
  s.plotBuilding[input.plotId] = id;
  s.rev++;
  emit(sim, { type: "spawned", kind: "building", id, data: building });
  return building;
}

// ---- derived indexes (not serialised) ----

type Index = { rev: number; poisByKind: Map<string, Poi[]>; buildingsByKind: Map<BuildingKind, Building[]> };
const indexes = new WeakMap<WorldState, Index>();

export function indexOf(s: WorldState): Index {
  const cached = indexes.get(s);
  if (cached && cached.rev === s.rev) return cached;
  const poisByKind = new Map<string, Poi[]>();
  const buildingsByKind = new Map<BuildingKind, Building[]>();
  for (const b of Object.values(s.buildings)) {
    (buildingsByKind.get(b.kind) ?? buildingsByKind.set(b.kind, []).get(b.kind)!).push(b);
    for (const id of b.poiIds) {
      const poi = s.pois[id]!;
      (poisByKind.get(poi.kind) ?? poisByKind.set(poi.kind, []).get(poi.kind)!).push(poi);
    }
  }
  const fresh = { rev: s.rev, poisByKind, buildingsByKind };
  indexes.set(s, fresh);
  return fresh;
}

export const buildingsOf = (s: WorldState, kind: BuildingKind): Building[] => indexOf(s).buildingsByKind.get(kind) ?? [];
export const poisOfBuilding = (s: WorldState, building: Building): Poi[] => building.poiIds.map((id) => s.pois[id]!);

export function reservePoi(s: WorldState, c: Citizen, poi: Poi | null): void {
  releasePoi(s, c);
  if (!poi) return;
  c.poi = poi.id;
  s.poiLoad[poi.id] = (s.poiLoad[poi.id] ?? 0) + 1;
}

export function releasePoi(s: WorldState, c: Citizen): void {
  if (!c.poi) return;
  const left = (s.poiLoad[c.poi] ?? 1) - 1;
  if (left > 0) s.poiLoad[c.poi] = left; else delete s.poiLoad[c.poi];
  c.poi = null;
}
