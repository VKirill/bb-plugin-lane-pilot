import { releasePoi } from "./buildings";
import { finishJob, releaseCitizen } from "./construction";
import { nextId, nextRandom } from "./rng";
import { emit, hours, planTo, type Sim } from "./sim";
import type { Job, Site, Vehicle, VehicleKind, WorldState } from "./types";

/** City services Lane Pilot work calls out: the inspector, the emergency van, a meeting in the office, and ambient traffic. */

const INSPECT_SECONDS = 45;
/** A van stays at the site until its repair ends; this is the longest it waits for that signal. */
const RESCUE_STAY_SECONDS = 3600;
const VAN_SPEED = 9;
const CAR_SPEED = 6;
const LANE = 1.2;
const MAX_AMBIENT = 12;

const roadPos = (s: WorldState, node: number) => ({ x: s.map.road.nodes[node]!.x, z: s.map.road.nodes[node]!.z });

export function sendInspector(sim: Sim, site: Site): boolean {
  const s = sim.s;
  if (Object.values(s.jobs).some((j) => j.kind === "inspect" && j.siteId === site.id)) return true;
  const plot = s.map.plots[site.plotId]!;
  let pick = null as null | (typeof s.citizens)[string], best = Infinity;
  for (const c of Object.values(s.citizens)) {
    if (c.role !== "inspector" || c.jobId || c.plan?.action === "sleep") continue;
    const d = Math.hypot(c.pos.x - plot.x0, c.pos.z - plot.z0);
    if (d < best) { pick = c; best = d; }
  }
  if (!pick) return false;
  releasePoi(s, pick);
  const job: Job = { id: nextId(s, "j"), kind: "inspect", siteId: site.id, state: "active", crew: [pick.id], need: 1, vehicleId: null, stage: 0, workLeft: 0, phase: "work", createdAt: s.time, until: 0 };
  s.jobs[job.id] = job;
  pick.jobId = job.id;
  job.until = planTo(sim, pick, s.map.sidewalk, plot.slots[0]!.node, { action: "inspect", clip: "inspect", dwell: INSPECT_SECONDS, target: site.id }).until;
  return true;
}

export function startRescue(sim: Sim, callId: string, targetPlotId: string, label: string): boolean {
  const s = sim.s;
  if (s.calls[callId]) return true;
  const depot = s.map.plots[s.map.depotPlotId]!;
  const target = s.map.plots[targetPlotId]!;
  const van: Vehicle = { id: nextId(s, "v"), kind: "van", pos: roadPos(s, depot.roadNode), node: depot.roadNode, plan: null, jobId: null, label };
  const job: Job = { id: nextId(s, "j"), kind: "rescue", siteId: null, state: "active", crew: [], need: 0, vehicleId: van.id, stage: 0, workLeft: 0, phase: "to_site", createdAt: s.time, until: 0 };
  van.jobId = job.id;
  s.vehicles[van.id] = van;
  s.jobs[job.id] = job;
  s.calls[callId] = { target: targetPlotId, vehicleId: van.id, since: s.time };
  emit(sim, { type: "spawned", kind: "vehicle", id: van.id, data: van });
  job.until = planTo(sim, van, s.map.road, target.roadNode, { action: "drive", clip: "siren", dwell: RESCUE_STAY_SECONDS, speed: VAN_SPEED, lateral: LANE, target: targetPlotId }).until;
  return true;
}

export function endRescue(sim: Sim, callId: string): boolean {
  const call = sim.s.calls[callId];
  if (!call) return false;
  const job = Object.values(sim.s.jobs).find((j) => j.kind === "rescue" && j.vehicleId === call.vehicleId);
  if (job && job.phase === "to_site") job.until = sim.s.time;
  return true;
}

export function startMeeting(sim: Sim, councilId: string, want = 6): boolean {
  const s = sim.s;
  const id = `m:${councilId}`;
  if (s.meetings[id]) return true;
  const office = Object.values(s.buildings).find((b) => b.kind === "office");
  if (!office) return false;
  const seats = office.poiIds.filter((p) => s.pois[p]!.kind === "seat");
  const free = (c: (typeof s.citizens)[string]) => !c.jobId && c.plan?.action !== "sleep";
  const staff = Object.values(s.citizens).filter((c) => c.workId === office.id && free(c));
  const others = Object.values(s.citizens).filter((c) => c.workId !== office.id && c.role !== "builder" && free(c));
  const people = [...staff, ...others].slice(0, Math.min(want, seats.length));
  if (!people.length) return false;
  const meeting = { id, seats: seats.slice(0, people.length), citizenIds: people.map((c) => c.id), since: s.time };
  s.meetings[id] = meeting;
  people.forEach((c, i) => {
    const poi = s.pois[meeting.seats[i]!]!;
    releasePoi(s, c);
    c.jobId = id;
    planTo(sim, c, s.map.sidewalk, poi.node, { action: "meeting", clip: poi.clip, dwell: hours(s, 8), target: poi.id });
  });
  emit(sim, { type: "meeting", meetingId: id, state: "started", citizenIds: meeting.citizenIds });
  return true;
}

export function endMeeting(sim: Sim, councilId: string): boolean {
  const s = sim.s;
  const id = `m:${councilId}`;
  const meeting = s.meetings[id];
  if (!meeting) return false;
  for (const cid of meeting.citizenIds) { const c = s.citizens[cid]; if (c) releaseCitizen(sim, c); }
  delete s.meetings[id];
  emit(sim, { type: "meeting", meetingId: id, state: "ended", citizenIds: meeting.citizenIds });
  return true;
}

export function spawnTraffic(sim: Sim, kind: VehicleKind = "car", count = 1): number {
  const s = sim.s;
  const road = s.map.road;
  let made = 0;
  for (let i = 0; i < count; i++) {
    if (Object.values(s.vehicles).filter((v) => v.kind === "car").length >= MAX_AMBIENT) break;
    const a = Math.floor(nextRandom(s) * road.nodes.length), b = Math.floor(nextRandom(s) * road.nodes.length);
    if (a === b) continue;
    const car: Vehicle = { id: nextId(s, "v"), kind, pos: roadPos(s, a), node: a, plan: null, jobId: null };
    s.vehicles[car.id] = car;
    emit(sim, { type: "spawned", kind: "vehicle", id: car.id, data: car });
    planTo(sim, car, road, b, { action: "drive", clip: "drive", dwell: 0, speed: CAR_SPEED, lateral: LANE });
    made++;
  }
  return made;
}

/** Inspections end, vans go home when their call ends, ambient cars disappear at their destination. */
export function updateServices(sim: Sim): void {
  const s = sim.s;
  for (const job of Object.values(s.jobs)) {
    if (s.time < job.until) continue;
    if (job.kind === "inspect") finishJob(sim, job);
    else if (job.kind === "rescue") {
      const van = job.vehicleId ? s.vehicles[job.vehicleId] : null;
      if (!van) { delete s.jobs[job.id]; continue; }
      if (job.phase === "to_site") {
        job.phase = "return";
        job.until = planTo(sim, van, s.map.road, s.map.plots[s.map.depotPlotId]!.roadNode, { action: "drive", clip: "drive", dwell: 0, speed: VAN_SPEED, lateral: LANE }).until;
      } else {
        for (const [callId, call] of Object.entries(s.calls)) if (call.vehicleId === van.id) delete s.calls[callId];
        delete s.vehicles[van.id];
        delete s.jobs[job.id];
        emit(sim, { type: "removed", kind: "vehicle", id: van.id });
      }
    }
  }
  for (const v of Object.values(s.vehicles)) {
    if (v.kind === "car" && !v.jobId && v.plan && s.time >= v.plan.until) {
      delete s.vehicles[v.id];
      emit(sim, { type: "removed", kind: "vehicle", id: v.id });
    }
  }
}
