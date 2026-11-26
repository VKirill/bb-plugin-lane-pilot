import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { wfRunUsage, type NodeExecutor, type StepContext, type WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { RoadEvidence } from "../../../contracts";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import { isSandboxProject } from "../../../owner-waiting";
import { loadProjectSettings } from "../../../storage";
import { loadIdentity } from "../../identity";
import { processPartsOf, processStemOf, proposalDecisionId, proposalProblem, seedForm, tickBrief, type ArchitectSeed, type Proposal } from "../../models/tick";
import { parseLeadSettings } from "../../settings";
import { addRoad, getRoad, listRoad, proposeRoad, syncRoadProposal } from "../repositories/road-repository";
import { closeTick as closeTickRow, getTick, openTick, patchTick } from "../repositories/tick-repository";
import { hubSnapshot, listProjects, projectRoot, type TickServices } from "../services/tick-service";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const KNOWN_EVIDENCE = new Set(["run", "task", "file", "note", "url", "metric"]);
const cleanEvidence = (items: unknown): RoadEvidence[] =>
  (Array.isArray(items) ? items : []).filter((item): item is RoadEvidence => Boolean(item) && typeof (item as RoadEvidence).ref === "string" && (item as RoadEvidence).ref.trim() !== "")
    .slice(0, 12).map((item) => ({ kind: KNOWN_EVIDENCE.has(item.kind) ? item.kind : "note", ref: item.ref.slice(0, 500), ...(item.label ? { label: String(item.label).slice(0, 120) } : {}) }));

/** The seed as the branch stores it: the known fields only, `nearest` cut to four {kind,id,score} units of the two known kinds. */
function cleanArchitectSeed(raw: ArchitectSeed): ArchitectSeed {
  const seed: ArchitectSeed = {};
  for (const key of ["form", "kind", "stem", "target"] as const) { const value = text(raw[key]); if (value) seed[key] = value; }
  const threads = (Array.isArray(raw.threadIds) ? raw.threadIds : []).map(String).filter(Boolean).slice(0, 10);
  if (threads.length) seed.threadIds = threads;
  const samples = (Array.isArray(raw.samples) ? raw.samples : []).map(String).filter(Boolean).slice(0, 3);
  if (samples.length) seed.samples = samples;
  const nearest = (Array.isArray(raw.nearest) ? raw.nearest : []).flatMap((unit) => {
    const entry = unit as { kind?: unknown; id?: unknown; score?: unknown };
    return typeof entry?.id === "string" && entry.id && (entry.kind === "graph" || entry.kind === "skill")
      ? [{ kind: entry.kind, id: entry.id.slice(0, 120), score: typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : 0 }] : [];
  }).slice(0, 4);
  if (nearest.length) seed.nearest = nearest;
  return seed;
}

/**
 * The code steps of the lead's tick (`workflows/lead-tick.json`): `lp.lead_state` reads the hub and writes the agent's
 * brief (including the `graphless` nearest-unit ladder for `lp.evolve`); `lp.lead_propose` records new branches and
 * proposals into `lane_pilot_lead_road`; `lp.lead_receipt` closes the tick row. Lead never posts owner cards or acts.
 */
export function registerLeadTickActions(engine: WorkflowEngine, ctx: ServerCore, services: TickServices): void {
  const { db, bb } = ctx;
  const settingsOf = () => parseLeadSettings(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID));
  const tickIdOf = (c: StepContext<ChainRuntime>) => text(c.resolve("$inputs.tickId")) || `tick_${c.runId.slice(-8)}`;

  engine.register<ChainRuntime>("lp.lead_state", {
    reentrant: true,
    run: async (c) => {
      const settings = settingsOf();
      const tickId = tickIdOf(c);
      const maybe = (ref: string) => { try { return c.resolve(ref); } catch { return undefined; } };
      const trigger = text(maybe("$inputs.trigger")) || "manual";
      const scoped = text(maybe("$inputs.projectId")).trim();
      const effective = scoped ? { ...settings, enabled: settings.enabled && (!settings.projects.length || settings.projects.includes(scoped)), projects: [scoped] } : settings;
      if (!getTick(db, tickId)) try { openTick(db, trigger, Date.now(), tickId); } catch { /* receipt row best effort */ }
      const snapshot = await hubSnapshot(ctx, effective, { tickId, trigger }, Date.now(), services);
      const identity = loadIdentity();
      const overBudget = snapshot.budget.leftUsd <= 0;
      try { patchTick(db, tickId, { state_json: JSON.stringify({ projects: snapshot.projects.map((project) => ({ id: project.id, runs: project.runs, tasks30d: project.tasks30d })), road: snapshot.road.counts, proposalsOpen: snapshot.proposalsOpen, budget: snapshot.budget }), identity_sha: identity.sha, wf_run_id: c.runId }); } catch { /* the receipt is best effort */ }
      return { output: { enabled: effective.enabled, over_budget: overBudget, budget_left_usd: snapshot.budget.leftUsd, brief: effective.enabled && !overBudget ? tickBrief(snapshot, identity.text) : "", projects: snapshot.projects.length, open_branches: snapshot.road.open.length } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.lead_propose", {
    reentrant: true,
    run: async (c) => {
      const now = Date.now();
      const settings = settingsOf();
      const tickId = tickIdOf(c);
      const names = new Map((await listProjects(bb)).map((project) => [project.id, project.name]));
      const branches = (Array.isArray(c.resolve("think.branches")) ? c.resolve("think.branches") : []) as Array<Record<string, unknown>>;
      const added: string[] = [];
      for (const branch of branches.slice(0, 20)) {
        try {
          const title = text(branch.title).trim(), why = text(branch.why).trim();
          if (!title || why.length < 10) continue;
          const kind = branch.kind === "direction" ? "direction" : "option";
          const projectId = typeof branch.project_id === "string" && branch.project_id ? branch.project_id : null;
          // A branch of a project outside the zone (or a sandbox one) is not written: the tree is bound to lead.projects like the proposals (Astra F-010c).
          if (projectId && (settings.projects.length ? !settings.projects.includes(projectId) : isSandboxProject(projectId))) continue;
          const parent = typeof branch.parent_id === "string" && getRoad(db, branch.parent_id) ? branch.parent_id : kind === "option" ? projectRoot(db, projectId, names.get(projectId ?? "") ?? null, now).id : null;
          if (listRoad(db, { parentId: parent, limit: 200 }).some((row) => row.title.trim().toLowerCase() === title.toLowerCase())) continue;
          added.push(addRoad(db, { parentId: parent, projectId, title, kind, source: "lead", why }, now).id);
        } catch (cause) { bb.log.warn(`lead tick ${tickId}: branch not added: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }

      const raw = (Array.isArray(c.resolve("think.proposals")) ? c.resolve("think.proposals") : []) as Array<Partial<Proposal>>;
      const proposed: Array<{ roadId: string; decisionId: string; title: string; class: string }> = [];
      const dropped: Array<{ title: string; reason: string }> = [];
      for (const item of raw) {
        const proposal: Partial<Proposal> = { ...item, evidence: cleanEvidence(item.evidence) };
        const problem = proposalProblem(proposal);
        if (problem) { dropped.push({ title: clip(text(item.title) || "(no title)", 120), reason: problem }); continue; }
        if (proposed.length >= settings.maxProposals) { dropped.push({ title: clip(proposal.title!, 120), reason: `over the day's ${settings.maxProposals} proposals` }); continue; }
        try {
          const rawSeed = proposal.class === "process" ? proposal.architectSeed : undefined;
          const seed = rawSeed && typeof rawSeed === "object" ? cleanArchitectSeed(rawSeed as ArchitectSeed) : undefined;
          if (seed !== undefined && seedForm(seed) === null) {
            // A form the code does not know is refused and logged, never bent into a graph (the old default's bug).
            dropped.push({ title: clip(proposal.title!, 120), reason: `unknown process form ${clip(text(seed.form) || "(none)", 40)}` });
            bb.log.warn(`lead tick ${tickId}: process proposal refused, unknown form «${clip(text(seed.form), 40) || "(none)"}» on «${clip(proposal.title!, 80)}»`);
            continue;
          }
          let row = proposal.road_id ? getRoad(db, proposal.road_id) : undefined;
          if (!row && seed !== undefined) {
            const form = seedForm(seed)!;
            const stem = processStemOf(proposal.title!);
            const twin = listRoad(db, { limit: 500 }).find((entry) => {
              const parts = processPartsOf(entry.title);
              return parts.stem === stem && (parts.form === null || parts.form === form);
            });
            if (twin && twin.state !== "open" && twin.state !== "later") { dropped.push({ title: clip(proposal.title!, 120), reason: `a branch titled «${clip(twin.title, 80)}» is already ${twin.state}` }); continue; }
            row = twin;
          }
          if (row && row.state !== "open" && row.state !== "later") { dropped.push({ title: clip(proposal.title!, 120), reason: `branch ${row.id} is ${row.state}` }); continue; }
          const projectId = row?.project_id ?? (typeof proposal.project_id === "string" && proposal.project_id ? proposal.project_id : null);
          if (projectId && settings.projects.length && !settings.projects.includes(projectId)) { dropped.push({ title: clip(proposal.title!, 120), reason: `project ${projectId} is outside lead.projects` }); continue; }
          if (projectId && !settings.projects.includes(projectId) && isSandboxProject(projectId)) { dropped.push({ title: clip(proposal.title!, 120), reason: `project ${projectId} is a sandbox or bench project: outside the zone` }); continue; }
          if (!row) {
            const parent = proposal.parent_id && getRoad(db, proposal.parent_id) ? proposal.parent_id : projectRoot(db, projectId, names.get(projectId ?? "") ?? null, now).id;
            row = addRoad(db, { parentId: parent, projectId, title: proposal.title!.trim(), kind: "option", source: "lead", why: proposal.why!.trim(), evidence: proposal.evidence, costEstimate: proposal.cost_estimate!.trim(), class: proposal.class!,
              payload: proposal.class === "schedule" ? proposal.schedule : seed !== undefined ? { architectSeed: seed } : undefined }, now);
          } else {
            syncRoadProposal(db, row.id, { class: proposal.class!, why: proposal.why!.trim(), evidence: proposal.evidence, costEstimate: proposal.cost_estimate!.trim(), projectId,
              ...(proposal.class === "schedule" && proposal.schedule !== undefined ? { payload: proposal.schedule } : seed !== undefined ? { payload: { architectSeed: seed } } : {}) }, now);
            row = getRoad(db, row.id)!;
          }
          const decisionId = proposalDecisionId(row.id, tickId);
          proposeRoad(db, row.id, decisionId, now);
          proposed.push({ roadId: row.id, decisionId, title: row.title, class: proposal.class! });
        } catch (cause) { dropped.push({ title: clip(proposal.title!, 120), reason: `not recorded: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 200) }); }
      }
      try { patchTick(db, tickId, { candidates_json: JSON.stringify(raw.map((item) => ({ title: clip(text(item.title), 160), class: item.class, risk: item.risk }))), proposed_json: JSON.stringify(proposed) }); } catch { /* receipt is best effort */ }
      return { output: { proposed: proposed.length, proposed_json: JSON.stringify(proposed), dropped_json: JSON.stringify(dropped), branches_added: added.length } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.lead_receipt", {
    reentrant: true,
    run: async (c) => {
      const now = Date.now();
      const tickId = tickIdOf(c);
      const maybe = (ref: string): unknown => { try { return c.resolve(ref); } catch { return undefined; } };
      const enabled = maybe("state.enabled") !== false;
      const overBudget = maybe("state.over_budget") === true;
      const thinkStatus = text(maybe("think.status"));
      const summary = text(maybe("think.summary"));
      const status = !enabled ? "off" : overBudget ? "budget" : thinkStatus === "blocked" ? "error" : summary ? "ok" : "no_receipt";
      const proposed = Number(maybe("propose.proposed") ?? 0) || 0;
      const parse = (ref: string) => { try { return JSON.parse(text(maybe(ref)) || "[]") as unknown[]; } catch { return []; } };
      const deferred = { lead: clip(text(maybe("think.deferred")), 2_000), dropped: parse("propose.dropped_json") };
      const usage = wfRunUsage(db as never, c.runId);
      try {
        patchTick(db, tickId, { deferred_json: JSON.stringify(deferred), tokens: usage?.tokens_used ?? null, cost_micro_usd: usage?.cost_micro_usd ?? null });
        closeTickRow(db, tickId, status, now);
      } catch (cause) { bb.log.warn(`lead tick ${tickId}: receipt not written: ${cause instanceof Error ? cause.message : String(cause)}`); }
      if (status !== "ok" && status !== "off") bb.log.warn(`lead tick ${tickId}: ended ${status}`);
      const report = [summary, proposed ? `Предложений: ${proposed}` : "", deferred.dropped.length ? `Отброшено кодом: ${deferred.dropped.length}` : ""].filter(Boolean).join("\n");
      return { output: { status, proposed, report } };
    },
  } as NodeExecutor<ChainRuntime>);
}
