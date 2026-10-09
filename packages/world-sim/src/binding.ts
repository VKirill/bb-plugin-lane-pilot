import { damageSite, ensureDistrict, createSite, setTarget, siteOfAttempt, targetForPercent } from "./construction";
import { endMeeting, endRescue, sendInspector, startMeeting, startRescue } from "./services";
import { emit, type Sim } from "./sim";
import type { LanePilotSignal, Site, SignalType, StepResult, WorldState } from "./types";

/**
 * Lane Pilot to world: the one place that says what each kind of work looks like in the city.
 * A rule returns null when it did what it says, or a short note when it could not (unknown attempt, no free plot).
 */
type Rule<T extends SignalType> = { world: string; apply: (sim: Sim, signal: Extract<LanePilotSignal, { type: T }>) => string | null };
type Rules = { [T in SignalType]: Rule<T> };

const UNKNOWN_ATTEMPT = "unknown attempt";

function withSite(sim: Sim, attemptId: string, then: (site: Site) => string | null): string | null {
  const site = siteOfAttempt(sim.s, attemptId);
  return site ? then(site) : UNKNOWN_ATTEMPT;
}

/** Where a rescue van goes: the attempt's site, else the project's collapsed (or latest) site, else the office. */
function rescueTarget(s: WorldState, signal: { attemptId?: string; projectId?: string }): string {
  const bySite = signal.attemptId ? siteOfAttempt(s, signal.attemptId) : null;
  if (bySite) return bySite.plotId;
  const pool = Object.values(s.sites).filter((x) => !signal.projectId || x.projectId === signal.projectId);
  const found = pool.filter((x) => x.collapsed).pop() ?? pool.pop();
  return found ? found.plotId : s.map.officePlotId;
}

export const SIGNAL_RULES: Rules = {
  project_upserted: {
    world: "a district: a free block is claimed for the project, with its colour and name on the sign",
    apply: (sim, sig) => { ensureDistrict(sim, sig.projectId, sig.name); return null; },
  },
  task_dispatched: {
    world: "a construction site appears on a plot of the project's district and the surveyor's crew sets out",
    apply: (sim, sig) => (createSite(sim, { projectId: sig.projectId, taskId: sig.taskId, attemptId: sig.attemptId, name: sig.title }) ? null : "no free plot for a new site"),
  },
  attempt_progress: {
    world: "the crew may work up to the stage that matches the percent: survey, foundation, frame, walls, roof, paint",
    apply: (sim, sig) => withSite(sim, sig.attemptId, (site) => { setTarget(site, targetForPercent(sig.percent)); return null; }),
  },
  verification: {
    world: "started: the inspector walks to the site with a tablet; passed: the site is approved; failed: it is marked rejected",
    apply: (sim, sig) => withSite(sim, sig.attemptId, (site) => {
      if (sig.phase === "started") return sendInspector(sim, site) ? null : "no free inspector";
      site.rejected = sig.phase === "failed";
      site.approved = sig.phase === "passed";
      emit(sim, { type: "site", siteId: site.id, state: sig.phase === "passed" ? "approved" : "rejected" });
      return null;
    }),
  },
  accepted: {
    world: "the crew is rushed through the remaining stages and the building opens; people move in",
    apply: (sim, sig) => withSite(sim, sig.attemptId, (site) => { site.approved = true; site.rejected = false; site.rush = true; setTarget(site, 6); return null; }),
  },
  failed: {
    world: "the scaffolding collapses and a repair crew is called",
    apply: (sim, sig) => withSite(sim, sig.attemptId, (site) => (damageSite(sim, site) ? null : "site already down or finished")),
  },
  self_repair_started: {
    world: "an emergency van drives to the affected site and stays until the repair ends",
    apply: (sim, sig) => (startRescue(sim, sig.id, rescueTarget(sim.s, sig), "self-repair") ? null : "no depot"),
  },
  self_repair_ended: {
    world: "the van drives back to the depot",
    apply: (sim, sig) => (endRescue(sim, sig.id) ? null : "no such repair"),
  },
  council_started: {
    world: "staff walk to the meeting room of the office and sit at the table",
    apply: (sim, sig) => (startMeeting(sim, sig.councilId, sig.seats) ? null : "nobody free to meet"),
  },
  council_ended: {
    world: "the meeting breaks up and everyone goes back to what they were doing",
    apply: (sim, sig) => (endMeeting(sim, sig.councilId) ? null : "no such meeting"),
  },
};

/** Applies one signal to the world (in place) and returns the events it caused, ending with a `signal` event. */
export function applyLanePilotSignal(state: WorldState, signal: LanePilotSignal): StepResult {
  const sim: Sim = { s: state, events: [] };
  const rule = SIGNAL_RULES[signal.type] as Rule<SignalType> | undefined;
  const note = rule ? rule.apply(sim, signal as never) : "unknown signal type";
  emit(sim, { type: "signal", signal, applied: note === null, ...(note ? { note } : {}) });
  return { state, events: sim.events };
}
