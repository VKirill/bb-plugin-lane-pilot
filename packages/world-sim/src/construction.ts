import { addBuilding, BLUEPRINT_KINDS, releasePoi } from "./buildings";
import { hashString, nextId, nextRandom, shuffle } from "./rng";
import { emit, hours, planTo, type Sim } from "./sim";
import { STAGES, type Building, type BuildingKind, type Citizen, type District, type Job, type Plot, type Site, type Vehicle, type WorldState } from "./types";

/** Crew-seconds of work each stage takes (survey, foundation, frame, walls, roof, paint). */
export const STAGE_WORK = [30, 360, 540, 450, 360, 180] as const;
/** Stage the truck brings materials for. */
export const STAGE_MATERIAL = ["", "concrete", "timber", "brick", "tiles", "paint"] as const;
export const CREW_SIZE = 3;
export const REPAIR_CREW = 2;
export const REPAIR_WORK = 120;
const RUSH = 4;
const UNLOAD_SECONDS = 20;
const MAX_TRUCKS = 4;
const OPEN_KEEP_SECONDS = 120;
const TRUCK_SPEED = 7;
const LANE = 1.2;

const PALETTE = [0xe4572e, 0x29a0b1, 0xf3a712, 0x7a5195, 0x59a14f, 0xd1495b, 0x3d7ea6, 0xc5a880, 0x8d6a9f, 0x4bb3a0, 0xef8354, 0x6c91bf];

/** Highest stage the crew may work on for an attempt that is `percent` done (the last one, `open`, comes only with acceptance). */
export const targetForPercent = (percent: number): number => Math.min(5, Math.max(0, Math.floor(Math.min(0.9999, Math.max(0, percent)) * 6)));

// ---- districts and plots ----

const plotFree = (s: WorldState, p: Plot) => !s.plotBuilding[p.id] && !s.plotSite[p.id] && !s.plotDistrict[p.id];

export function ensureDistrict(sim: Sim, projectId: string, name?: string): District {
  const s = sim.s;
  const known = s.projects[projectId];
  if (known && s.districts[known]) {
    if (name && s.districts[known]!.name !== name) { s.districts[known]!.name = name; emit(sim, { type: "district", district: s.districts[known]! }); }
    return s.districts[known]!;
  }
  const plots = Object.values(s.map.plots);
  const freeBy = (blockId: string) => plots.filter((p) => p.blockId === blockId && plotFree(s, p)).length;
  const blocks = s.map.blocks.filter((b) => b.kind === "free");
  // A block nobody has claimed from first; when all are shared, the one with the most room.
  const block = blocks.find((b) => freeBy(b.id) === plots.filter((p) => p.blockId === b.id).length) ?? [...blocks].sort((a, b) => freeBy(b.id) - freeBy(a.id))[0];
  const id = nextId(s, "d");
  const district: District = { id, projectId, name: name ?? projectId, blockId: block?.id ?? "", color: PALETTE[hashString(projectId) % PALETTE.length]!, plotIds: [], createdAt: s.time };
  s.districts[id] = district;
  s.projects[projectId] = id;
  emit(sim, { type: "district", district });
  return district;
}

/** A free plot of the district's block, else any free plot; when the city is full the oldest building made from a site is pulled down. */
function claimPlot(sim: Sim, district: District): Plot | null {
  const s = sim.s;
  const plots = Object.values(s.map.plots);
  let found = plots.find((p) => p.blockId === district.blockId && plotFree(s, p)) ?? plots.find((p) => p.zone === "free" && plotFree(s, p));
  if (!found) {
    const old = Object.values(s.buildings).filter((b) => b.siteId !== null).sort((a, b) => a.openedAt - b.openedAt)[0];
    if (!old) return null;
    found = s.map.plots[old.plotId]!;
    demolish(sim, old);
  }
  const previous = s.districts[s.plotDistrict[found.id] ?? ""];
  if (previous) previous.plotIds = previous.plotIds.filter((id) => id !== found!.id);
  s.plotDistrict[found.id] = district.id;
  district.plotIds.push(found.id);
  return found;
}

function demolish(sim: Sim, building: Building): void {
  const s = sim.s;
  for (const id of building.poiIds) { delete s.pois[id]; delete s.poiLoad[id]; }
  delete s.buildings[building.id];
  delete s.plotBuilding[building.plotId];
  delete s.plotDistrict[building.plotId];
  s.rev++;
  const home = Object.values(s.buildings).find((b) => b.kind === "house");
  for (const c of Object.values(s.citizens)) {
    if (c.homeId === building.id && home) c.homeId = home.id;
    if (c.workId === building.id) { c.workId = null; if (c.role === "worker") c.role = "resident"; }
  }
  emit(sim, { type: "removed", kind: "building", id: building.id });
}

// ---- sites ----

export const siteKey = (projectId: string, taskId: string) => `${projectId}/${taskId}`;

export function createSite(sim: Sim, input: { projectId: string; taskId: string; attemptId: string; name?: string }): Site | null {
  const s = sim.s;
  const existing = s.sites[s.tasks[siteKey(input.projectId, input.taskId)] ?? ""];
  if (existing) { bindAttempt(s, existing, input.attemptId); return existing; }
  const district = ensureDistrict(sim, input.projectId);
  const plot = claimPlot(sim, district);
  if (!plot) return null;
  const id = nextId(s, "s");
  const blueprint = BLUEPRINT_KINDS[hashString(input.taskId) % BLUEPRINT_KINDS.length]!;
  const site: Site = {
    id, projectId: input.projectId, districtId: district.id, taskId: input.taskId, attemptIds: [], plotId: plot.id, blueprint,
    name: input.name ?? input.taskId, stageIndex: 0, progress: 0, target: 0,
    delivered: [true, false, false, false, false, false, true], ordered: [false, false, false, false, false, false, false],
    collapsed: false, rejected: false, approved: false, rush: false, buildingId: null, createdAt: s.time, openedAt: null,
  };
  s.sites[id] = site;
  s.plotSite[plot.id] = id;
  s.tasks[siteKey(input.projectId, input.taskId)] = id;
  bindAttempt(s, site, input.attemptId);
  emit(sim, { type: "spawned", kind: "site", id, data: site });
  emit(sim, { type: "site", siteId: id, state: "created" });
  return site;
}

function bindAttempt(s: WorldState, site: Site, attemptId: string): void {
  s.attempts[attemptId] = site.id;
  if (!site.attemptIds.includes(attemptId)) site.attemptIds.push(attemptId);
}

export const siteOfAttempt = (s: WorldState, attemptId: string): Site | null => s.sites[s.attempts[attemptId] ?? ""] ?? null;

export function setTarget(site: Site, target: number): void {
  // Progress only moves forward; a lower number from a retry does not undo work.
  if (target > site.target) site.target = Math.min(6, target);
}

export function damageSite(sim: Sim, site: Site): boolean {
  if (site.collapsed || site.stageIndex >= 6) return false;
  site.collapsed = true;
  site.progress = 0;
  if (site.stageIndex >= 2) { site.stageIndex--; emit(sim, { type: "stage", siteId: site.id, stage: STAGES[site.stageIndex]!, stageIndex: site.stageIndex, progress: 0 }); }
  emit(sim, { type: "site", siteId: site.id, state: "collapsed" });
  const build = jobFor(sim.s, "build", site.id);
  if (build) finishJob(sim, build);
  return true;
}

// ---- jobs ----

function jobFor(s: WorldState, kind: Job["kind"], siteId: string): Job | null {
  for (const job of Object.values(s.jobs)) if (job.kind === kind && job.siteId === siteId) return job;
  return null;
}

export function releaseCitizen(sim: Sim, c: Citizen): void {
  const s = sim.s;
  const job = c.jobId ? s.jobs[c.jobId] : null;
  if (job) job.crew = job.crew.filter((id) => id !== c.id);
  c.jobId = null;
  // The plan ends now; the citizen decides again at the next step (a walk in progress is finished first).
  if (c.plan) c.plan.until = Math.min(c.plan.until, Math.max(s.time, c.plan.arriveAt));
}

export function finishJob(sim: Sim, job: Job): void {
  for (const id of [...job.crew]) { const c = sim.s.citizens[id]; if (c) releaseCitizen(sim, c); }
  delete sim.s.jobs[job.id];
}

function newJob(s: WorldState, input: Partial<Job> & Pick<Job, "kind">): Job {
  const job: Job = { id: nextId(s, "j"), siteId: null, state: "open", crew: [], need: 0, vehicleId: null, stage: 0, workLeft: 0, phase: "work", createdAt: s.time, until: 0, ...input };
  s.jobs[job.id] = job;
  return job;
}

// ---- deliveries ----

/** Stages (from the current one up to one beyond the target) whose materials are neither here nor on their way. */
export function missingStage(site: Site, lookAhead: boolean): number | null {
  if (site.collapsed || site.stageIndex >= 6) return null;
  const last = Math.min(5, lookAhead ? site.target + 1 : site.stageIndex);
  for (let i = site.stageIndex; i <= last; i++) if (!site.delivered[i] && !site.ordered[i]) return i;
  return null;
}

export function sitesNeedingMaterials(s: WorldState): Site[] {
  return Object.values(s.sites).filter((site) => missingStage(site, true) !== null);
}

export function orderDelivery(sim: Sim, site: Site, stage: number): boolean {
  const s = sim.s;
  if (Object.values(s.vehicles).filter((v) => v.kind === "truck").length >= MAX_TRUCKS) return false;
  const depot = s.map.plots[s.map.depotPlotId]!;
  const target = s.map.plots[site.plotId]!;
  const truck: Vehicle = { id: nextId(s, "v"), kind: "truck", pos: nodePos(s, depot.roadNode), node: depot.roadNode, plan: null, jobId: null, label: STAGE_MATERIAL[stage] };
  const job = newJob(s, { kind: "deliver", siteId: site.id, stage, state: "active", phase: "to_site", vehicleId: truck.id });
  truck.jobId = job.id;
  s.vehicles[truck.id] = truck;
  site.ordered[stage] = true;
  emit(sim, { type: "spawned", kind: "vehicle", id: truck.id, data: truck });
  const plan = planTo(sim, truck, s.map.road, target.roadNode, { action: "drive", clip: "drive", dwell: UNLOAD_SECONDS, speed: TRUCK_SPEED, lateral: LANE, target: site.id });
  job.until = plan.until;
  return true;
}

const nodePos = (s: WorldState, node: number) => ({ x: s.map.road.nodes[node]!.x, z: s.map.road.nodes[node]!.z });

function advanceDeliveries(sim: Sim): void {
  const s = sim.s;
  for (const job of Object.values(s.jobs)) {
    if (job.kind !== "deliver" || s.time < job.until) continue;
    const truck = job.vehicleId ? s.vehicles[job.vehicleId] : null;
    const site = job.siteId ? s.sites[job.siteId] : null;
    if (!truck) { delete s.jobs[job.id]; continue; }
    if (job.phase === "to_site") {
      if (site) { site.delivered[job.stage] = true; emit(sim, { type: "site", siteId: site.id, state: "delivered" }); }
      job.phase = "return";
      const depot = s.map.plots[s.map.depotPlotId]!;
      job.until = planTo(sim, truck, s.map.road, depot.roadNode, { action: "drive", clip: "drive", dwell: 0, speed: TRUCK_SPEED, lateral: LANE }).until;
    } else {
      delete s.vehicles[truck.id];
      delete s.jobs[job.id];
      emit(sim, { type: "removed", kind: "vehicle", id: truck.id });
    }
  }
}

// ---- crews and progress ----

function workable(site: Site): boolean {
  if (site.collapsed || site.stageIndex >= 6) return false;
  if (!site.delivered[site.stageIndex]) return false;
  return site.progress < 1 || site.stageIndex < Math.min(5, site.target);
}

const crewReady = (c: Citizen) => c.role === "builder" && !c.jobId && c.plan?.action !== "sleep" && c.needs.hunger > 0.2 && c.needs.energy > 0.15;

function assignCrews(sim: Sim, jobs: Job[]): void {
  const s = sim.s;
  for (const job of jobs) {
    const site = s.sites[job.siteId ?? ""];
    if (!site) continue;
    const plot = s.map.plots[site.plotId]!;
    while (job.crew.length < job.need) {
      let pick: Citizen | null = null, bestDist = Infinity;
      for (const c of Object.values(s.citizens)) {
        if (!crewReady(c)) continue;
        const d = Math.hypot(c.pos.x - plot.x0, c.pos.z - plot.z0);
        if (d < bestDist) { pick = c; bestDist = d; }
      }
      if (!pick) return;
      releasePoi(s, pick);
      pick.jobId = job.id;
      job.crew.push(pick.id);
      job.state = "active";
      const slot = plot.slots[(job.crew.length - 1) % plot.slots.length]!;
      planTo(sim, pick, s.map.sidewalk, slot.node, { action: job.kind === "repair" ? "repair" : "build", clip: "hammer", dwell: hours(s, 6), target: site.id });
    }
  }
}

function openSite(sim: Sim, site: Site): void {
  const s = sim.s;
  site.stageIndex = 6;
  site.progress = 0;
  site.openedAt = s.time;
  const building: Building = addBuilding(sim, { plotId: site.plotId, kind: site.blueprint, name: site.name, districtId: site.districtId, siteId: site.id });
  site.buildingId = building.id;
  delete s.plotSite[site.plotId];
  emit(sim, { type: "stage", siteId: site.id, stage: "open", stageIndex: 6, progress: 0 });
  emit(sim, { type: "site", siteId: site.id, state: "opened", buildingId: building.id });
  const build = jobFor(s, "build", site.id);
  if (build) finishJob(sim, build);
  moveIn(sim, building.kind, building.id);
}

/** People settle into what opens: a house gets residents, a cafe or shop workers. */
function moveIn(sim: Sim, kind: BuildingKind, buildingId: string): void {
  const s = sim.s;
  const people = shuffle(s, Object.values(s.citizens));
  if (kind === "house") {
    for (const c of people.filter((x) => x.role === "resident" || x.role === "worker").slice(0, 2)) c.homeId = buildingId;
  } else if (kind === "cafe" || kind === "shop" || kind === "workshop") {
    for (const c of people.filter((x) => x.role === "resident" && !x.workId).slice(0, 2)) { c.workId = buildingId; c.role = "worker"; }
  }
}

/** Advances construction by `dt` sim seconds: orders trucks, staffs crews, moves progress, opens finished buildings. */
export function updateConstruction(sim: Sim, dt: number): void {
  const s = sim.s;
  advanceDeliveries(sim);
  const sites = Object.values(s.sites);
  const wanting: Job[] = [];
  for (const site of sites) {
    if (site.stageIndex >= 6) continue;
    if (site.stageIndex === 5 && site.progress >= 1 && site.target >= 6 && !site.collapsed) { openSite(sim, site); continue; }
    const stage = missingStage(site, false);
    if (stage !== null) orderDelivery(sim, site, stage);
    if (site.collapsed) {
      let repair = jobFor(s, "repair", site.id);
      if (!repair) repair = newJob(s, { kind: "repair", siteId: site.id, need: REPAIR_CREW, workLeft: REPAIR_WORK });
      wanting.push(repair);
      continue;
    }
    let build = jobFor(s, "build", site.id);
    if (workable(site)) {
      if (!build) build = newJob(s, { kind: "build", siteId: site.id, need: CREW_SIZE });
      wanting.push(build);
    } else if (build) finishJob(sim, build);
  }
  // Builders who are hungry or worn out leave their crew and look after themselves.
  for (const c of Object.values(s.citizens)) {
    const job = c.jobId ? s.jobs[c.jobId] : null;
    if (job && (job.kind === "build" || job.kind === "repair") && (c.needs.hunger < 0.12 || c.needs.energy < 0.1)) releaseCitizen(sim, c);
  }
  assignCrews(sim, wanting);

  for (const job of wanting) {
    const site = s.sites[job.siteId ?? ""];
    if (!site || !s.jobs[job.id]) continue;
    const present = job.crew.reduce((n, id) => {
      const plan = s.citizens[id]?.plan;
      return plan && (plan.action === "build" || plan.action === "repair") && s.time >= plan.arriveAt ? n + 1 : n;
    }, 0);
    if (!present) continue;
    if (job.kind === "repair") {
      job.workLeft -= present * dt;
      if (job.workLeft <= 0) {
        site.collapsed = false;
        finishJob(sim, job);
        emit(sim, { type: "site", siteId: site.id, state: "repaired" });
      }
      continue;
    }
    site.progress += (present * dt * (site.rush ? RUSH : 1)) / STAGE_WORK[site.stageIndex]!;
    while (site.progress >= 1) {
      if (site.stageIndex === 5) {
        if (site.target >= 6) { openSite(sim, site); break; }
        site.progress = 1;
        break;
      }
      if (site.stageIndex >= site.target) { site.progress = 1; break; }
      site.progress -= 1;
      site.stageIndex++;
      emit(sim, { type: "stage", siteId: site.id, stage: STAGES[site.stageIndex]!, stageIndex: site.stageIndex, progress: 0 });
    }
  }

  for (const site of sites) {
    if (site.stageIndex >= 6 && site.openedAt !== null && s.time - site.openedAt > OPEN_KEEP_SECONDS) {
      delete s.sites[site.id];
      delete s.tasks[siteKey(site.projectId, site.taskId)];
      for (const a of site.attemptIds) delete s.attempts[a];
      emit(sim, { type: "removed", kind: "site", id: site.id });
    }
  }
}

export const randomSite = (s: WorldState): Site | null => {
  const open = Object.values(s.sites).filter((x) => x.stageIndex >= 1 && x.stageIndex < 6 && !x.collapsed);
  return open.length ? open[Math.floor(nextRandom(s) * open.length)]! : null;
};
