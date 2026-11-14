// The four proofs per map node (sma-parity-tz.md §4) and their tallies: what `sma-map --states` and `--gaps` print.
//   checked          a contract test ([sma:<card>]) holds the code to the card's behaviour;
//   mutated          a kill attestation of the node's mutation spec (mutation.ts);
//   reachable        reachable under the hub's effective global settings (reach.ts), with the active projects whose
//                    own overrides block it;
//   outcomeVerified  checked ∧ mutated ∧ a node-level trace (traces.ts) newer than the node's change point
//                    (provenance.ts) — observed is the trace alone.
// Exceptions from the four: upstream, deviation, deviation-data, and a void whose review says void (voidReview).
// The group-level live signal (live.ts) is reported as groupObserved and never counts.
import { SMA_CONTRACT_TESTS } from "./contracts";
import { SMA_EVIDENCE } from "./evidence";
import type { NodeEvidence } from "./evidence/types";
import { SMA_LINKS, SMA_NODES, SMA_REGIONS } from "./graph";
import { SMA_HOLLOW_FACTS } from "./hollow-facts";
import { SMA_ATTEST, mutationState, type Attestation, type MutationRoots } from "./mutation";
import { siblingOf, type SiblingName } from "./siblings";
import type { SmaRow } from "./model";
import { changePoints, traceAfter, type ChangePoint, type VersionSeen } from "./provenance";
import { evaluateReach, undeclaredGates } from "./reach";
import type { EffectiveSettings, HubSettings } from "./settings-registry";
import { readTraces, traceLabel, type TraceContext, type TraceSource } from "./traces";

export type Proof = "test" | "mutation" | "reach" | "trace";
export type NodeState = {
  id: string; smaId: string; region: string; regionIndex: number; status: string; label: string;
  exception: "upstream" | "deviation" | "deviation-data" | "void-reviewed" | null;
  voidUnreviewed: boolean;
  checked: boolean;
  mutated: boolean; mutationStale: boolean | null; mutationWhy: string;
  reachable: boolean; reachWhy: string; seededEntry: boolean; blockedIn: string[]; undeclared: string[];
  observed: boolean | null; traceLast: number | null; traces: string[];
  changePoint: ChangePoint;
  outcomeVerified: boolean | null;
  groupObserved: boolean | null;
  missing: Proof[];
  /** The sibling repository the node's proof anchor lives in (siblings.ts), or null for this one. */
  sibling: SiblingName | null;
};

const traceList = (evidence: NodeEvidence | undefined): TraceSource[] => (evidence?.trace === undefined ? [] : Array.isArray(evidence.trace) ? [...evidence.trace] : [evidence.trace as TraceSource]);
/** The card's contract test files in the repository the mutation lives in (a sibling's carry its prefix): those are what the runner ran. */
export const testFiles = (smaId: string, mutatedFile?: string) => {
  const repo = siblingOf(mutatedFile);
  return [...new Set((SMA_CONTRACT_TESTS[smaId] ?? []).map((line) => line.split(" › ")[0]!).filter((file) => siblingOf(file) === repo))].sort();
};

export type StatesInput = {
  rows: readonly SmaRow[];
  /** A source checkout ("" on the hub): enables the stale checks of attestations and change points. */
  root: string;
  settings: EffectiveSettings;
  hub?: HubSettings;
  /** With a database or drills: node-level traces are read over the window that starts at `since`. */
  traceCtx?: TraceContext;
  since?: number;
  groupObserved?: (row: SmaRow) => boolean | undefined;
  evidence?: Readonly<Record<string, NodeEvidence>>;
  attest?: Readonly<Record<string, Attestation>>;
  /** Setting keys each node's function reads (hollow-facts): fresh in a checkout, the shipped file on the hub. */
  settingReads?: Readonly<Record<string, string[]>>;
  /** On the hub: when each plugin version first ran (provenance.ts versionSeen) — dates changes newer than the file. */
  seen?: VersionSeen;
  /** The sibling checkouts present here (siblings.ts): a `core:`/`telegram:` attestation is re-judged there; in a source
   * checkout without that sibling the node is not mutated (absent, never a pass). */
  siblings?: MutationRoots;
};

export function nodeStates(input: StatesInput): NodeState[] {
  const evidence = input.evidence ?? SMA_EVIDENCE;
  const attest = input.attest ?? SMA_ATTEST;
  const settingReads = input.settingReads ?? SMA_HOLLOW_FACTS.settingReads;
  const reachOf = (id: string) => evidence[id]?.reach;
  const global = evaluateReach(SMA_NODES, SMA_LINKS, reachOf, input.settings);
  const perProject = (input.hub?.projects ?? []).filter((project) => project.overrides > 0).map((project) => ({ projectId: project.projectId, reach: evaluateReach(SMA_NODES, SMA_LINKS, reachOf, project.settings) }));
  const proofs = new Map(input.rows.map((row) => [row.id, row.proof] as const));
  const points = changePoints(input.rows.map((row) => row.id), SMA_LINKS, (id) => proofs.get(id), input.root, undefined, input.seen);
  // Reachability without the mechanically seeded entries: how much of `reachable` rests on them.
  const unseeded = evaluateReach(SMA_NODES, SMA_LINKS, (id) => { const spec = reachOf(id); return spec?.seeded ? undefined : spec; }, input.settings);
  const regionIndex = new Map(SMA_NODES.map(([id, region]) => [id, region] as const));
  const reading = input.traceCtx && input.since !== undefined;
  return input.rows.map((row) => {
    const ev = evidence[row.id];
    const exception = row.status === "upstream" || row.status === "deviation" || row.status === "deviation-data" ? row.status
      : row.status === "void" && ev?.voidReview?.verdict === "void" ? "void-reviewed" : null;
    const checked = row.contracts.length > 0;
    const mutation = mutationState(ev?.mutation, attest[row.id], input.root, testFiles(row.smaId, ev?.mutation?.file), input.siblings ?? {});
    const reach = global.get(row.id)!;
    const sources = traceList(ev);
    const traces = reading && sources.length ? readTraces(input.traceCtx!, sources, input.since!, row.id) : null;
    const observed = traces ? (traces.judged ? traces.n > 0 : null) : null;
    const point = points.get(row.id)!;
    const outcomeVerified = reading ? checked && mutation.mutated && !!traces?.judged && traceAfter(point, traces.last) : null;
    const missing: Proof[] = exception ? [] : [
      ...(checked ? [] : ["test" as const]), ...(mutation.mutated ? [] : ["mutation" as const]), ...(reach.reachable ? [] : ["reach" as const]),
      ...(traces?.judged && traceAfter(point, traces.last) ? [] : ["trace" as const]),
    ];
    return {
      id: row.id, smaId: row.smaId, region: row.region, regionIndex: regionIndex.get(row.id) ?? -1, status: row.status, label: row.label,
      exception, voidUnreviewed: row.status === "void" && !ev?.voidReview,
      checked, mutated: mutation.mutated, mutationStale: mutation.stale, mutationWhy: mutation.why,
      reachable: reach.reachable, reachWhy: reach.why, seededEntry: reach.reachable && !unseeded.get(row.id)!.reachable,
      blockedIn: reach.reachable ? perProject.filter((project) => !project.reach.get(row.id)!.reachable).map((project) => project.projectId) : [],
      undeclared: row.status === "have" || row.status === "partial" ? undeclaredGates(settingReads[row.id] ?? null, ev?.reach, input.settings) : [],
      observed, traceLast: traces?.last ?? null, traces: sources.map(traceLabel),
      changePoint: point, outcomeVerified, groupObserved: input.groupObserved?.(row) ?? null, missing, sibling: siblingOf(row.proof),
    };
  });
}

export type StateTally = {
  total: number; available: number; checked: number;
  mutated: number; mutationStale: number;
  reachable: number; unreachable: number; undeclared: number; seededReachable: number; blockedInSomeProject: number;
  observed: number | null; outcomeVerified: number | null; groupObserved: number | null;
  voidUnreviewed: number; exceptions: Record<string, number>;
  closed: number;
  /** Nodes whose proof lives in a sibling repository, and those of them closed on all four proofs while their change point is
   * a sibling commit the hub cannot date (provenance.ts traceAfter): visible, never folded silently into `closed`'s meaning. */
  sibling: number; closedSiblingUnknown: number;
};

export function tallyStates(states: readonly NodeState[], live: boolean): StateTally {
  const t: StateTally = { total: states.length, available: 0, checked: 0, mutated: 0, mutationStale: 0, reachable: 0, unreachable: 0, undeclared: 0, seededReachable: 0, blockedInSomeProject: 0,
    observed: live ? 0 : null, outcomeVerified: live ? 0 : null, groupObserved: states.some((state) => state.groupObserved !== null) ? 0 : null, voidUnreviewed: 0, exceptions: {}, closed: 0, sibling: 0, closedSiblingUnknown: 0 };
  for (const state of states) {
    if (state.status === "have" || state.status === "partial") t.available++;
    if (state.checked) t.checked++;
    if (state.mutated) t.mutated++;
    if (state.mutated && state.mutationStale) t.mutationStale++;
    if (state.reachable) t.reachable++; else t.unreachable++;
    if (state.reachable && state.seededEntry) t.seededReachable++;
    if (state.undeclared.length) t.undeclared++;
    if (state.blockedIn.length) t.blockedInSomeProject++;
    if (live && state.observed) t.observed!++;
    if (live && state.outcomeVerified) t.outcomeVerified!++;
    if (state.groupObserved) t.groupObserved!++;
    if (state.voidUnreviewed) t.voidUnreviewed++;
    if (state.exception) t.exceptions[state.exception] = (t.exceptions[state.exception] ?? 0) + 1;
    if (state.exception || !state.missing.length) t.closed++;
    if (state.sibling) t.sibling++;
    if (!state.exception && !state.missing.length && state.changePoint.state === "sibling") t.closedSiblingUnknown++;
  }
  return t;
}

/** The tally overall and per region (SMA_REGIONS order). */
export function stateReport(states: readonly NodeState[], live: boolean) {
  return { overall: tallyStates(states, live), regions: SMA_REGIONS.map((region, index) => ({ index, region, ...tallyStates(states.filter((state) => state.regionIndex === index), live) })) };
}

/** Per node which of the four proofs is missing — what batches are cut from. Exceptions are left out; an unreviewed void
 * is listed with `voidReview` missing as well. */
export function gapList(states: readonly NodeState[]) {
  return states.filter((state) => state.missing.length || state.voidUnreviewed).map((state) => ({
    id: state.id, smaId: state.smaId, region: state.regionIndex, status: state.status, label: state.label,
    missing: [...state.missing, ...(state.voidUnreviewed ? ["voidReview"] : [])],
    ...(state.reachable ? {} : { reachWhy: state.reachWhy }),
    ...(state.undeclared.length ? { undeclared: state.undeclared } : {}),
    ...(state.blockedIn.length ? { blockedIn: state.blockedIn } : {}),
    ...(state.mutated ? {} : { mutationWhy: state.mutationWhy }),
    ...(state.changePoint.state === "shipped" ? { changedIn: state.changePoint.version }
      : state.changePoint.state === "sibling" ? { changePoint: `sibling ${state.changePoint.sibling} ${state.changePoint.commit} (${new Date(state.changePoint.committedAt).toISOString().slice(0, 10)}; the hub cannot date its deploy)` }
      : { changePoint: state.changePoint.state }),
    ...(state.sibling ? { sibling: state.sibling } : {}),
  }));
}
