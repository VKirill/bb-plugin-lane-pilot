// The mechanical validation of per-node evidence (tests/sma-evidence.test.ts runs it on the registry and on broken
// fixtures): a batch agent's line is accepted only when its node exists in that region, its setting keys are known,
// its mutation spec lints, its trace sources are well formed and its reviews say why.
import type { SmaEntry } from "./entries";
import type { NodeEvidence, NeedValue, RegionEvidence } from "./evidence/types";
import type { Attestation, MutationRoots } from "./mutation";
import { lintMutation } from "./mutation";
import { knownSettingKey } from "./settings-registry";
import type { TraceSource } from "./traces";

type Node = readonly [id: string, region: number, group: string, kind: string, label: string];
const EVIDENCE_KEYS = new Set(["mutation", "reach", "trace", "hollowAttested", "voidReview"]);
const REACH_KEYS = new Set(["entry", "needs", "notGatedBy", "seeded"]);
const words = (value: unknown) => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string" && word.trim().length > 0);
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/** Why a need value is malformed, or null. */
function needProblem(need: NeedValue): string | null {
  if (typeof need === "string" || Array.isArray(need)) return words(need) ? null : "an empty word";
  if (need && typeof need === "object" && "not" in need) return words(need.not) ? null : "not() with no word";
  if (need && typeof need === "object" && "set" in need) return need.set === true ? null : "set must be true";
  return "a need is a word, a list of words, not(...) or isSet()";
}

/** Why a trace source is malformed, or null. */
export function traceProblem(source: TraceSource): string | null {
  const s = source as Record<string, unknown>;
  const opt = (key: string) => (s[key] === undefined || words(s[key]) ? null : `${key} is empty`);
  switch (source.kind) {
    case "gate": return text(source.gate) ? opt("status") : "gate needs a name";
    case "stage": case "receipt": return text(source.stage) ? opt("state") : `${source.kind} needs a stage id`;
    case "transition": return source.from === undefined && source.to === undefined ? "a transition names from or to" : opt("from") ?? opt("to") ?? opt("reason");
    case "taskField": return text(source.field) ? opt("reason") : "taskField needs a field";
    case "wfRun": return words(source.workflow) ? opt("status") : "wfRun needs a workflow id";
    case "wfStep": return text(source.workflow) && words(source.node) ? opt("state") : "wfStep needs a workflow id and a node id";
    case "part": return source.section === undefined && source.partKind === undefined ? "part names a section or a kind" : opt("section") ?? opt("partKind");
    case "schedule": return text(source.name) ? opt("status") : "schedule needs a name";
    case "setting": return knownSettingKey(source.key) ? null : `unknown setting key ${source.key}`;
    case "rows": return !/^lane_pilot_\w+$/.test(source.table) ? `rows reads only lane_pilot_* tables, not «${source.table}»` : !/^\w+$/.test(source.clock) ? "rows needs a clock column" : /;|--/.test(source.where ?? "") ? "rows where may not hold ; or --" : null;
    case "kv": return text(source.key) ? null : "kv needs a key";
    case "rpc": return text(source.method) ? null : "rpc needs a method";
    case "drill": return text(source.scene) ? null : "drill needs a scene";
    case "outside": return text(source.where) ? null : "outside says where";
    default: return `unknown trace kind ${(source as { kind?: string }).kind}`;
  }
}

export type CheckInput = {
  byRegion: readonly RegionEvidence[];
  nodes: readonly Node[];
  entries: Readonly<Record<string, SmaEntry>>;
  attest?: Readonly<Record<string, Attestation>>;
  /** A source checkout: mutation specs must find their text exactly once. */
  root?: string;
  /** The sibling checkouts present here (siblings.ts): a `core:`/`telegram:` spec is checked there, else statically only. */
  siblings?: MutationRoots;
};

/** Every problem of the registry, one line each ([] when it is clean). */
export function evidenceProblems(input: CheckInput): string[] {
  const problems: string[] = [];
  const region = new Map(input.nodes.map(([id, index]) => [id, index] as const));
  const seen = new Map<string, number>();
  input.byRegion.forEach((file, index) => {
    for (const [id, evidence] of Object.entries(file) as Array<[string, NodeEvidence]>) {
      const at = `r${String(index).padStart(2, "0")} ${id}`;
      if (!region.has(id)) { problems.push(`${at}: unknown node`); continue; }
      if (region.get(id) !== index) problems.push(`${at}: the node belongs to region ${region.get(id)}`);
      if (seen.has(id)) problems.push(`${at}: also in r${String(seen.get(id)).padStart(2, "0")}`);
      seen.set(id, index);
      for (const key of Object.keys(evidence)) if (!EVIDENCE_KEYS.has(key)) problems.push(`${at}: unknown field ${key}`);
      const { reach, mutation, trace, hollowAttested, voidReview } = evidence;
      if (reach) {
        for (const key of Object.keys(reach)) if (!REACH_KEYS.has(key)) problems.push(`${at}: unknown reach field ${key}`);
        if (reach.entry !== undefined && !text(reach.entry)) problems.push(`${at}: an empty entry class`);
        for (const [key, need] of Object.entries(reach.needs ?? {})) {
          if (!knownSettingKey(key)) problems.push(`${at}: unknown setting key ${key}`);
          const bad = needProblem(need);
          if (bad) problems.push(`${at}: needs ${key}: ${bad}`);
        }
        for (const [key, why] of Object.entries(reach.notGatedBy ?? {})) {
          if (!knownSettingKey(key)) problems.push(`${at}: unknown setting key ${key} in notGatedBy`);
          if (!text(why)) problems.push(`${at}: notGatedBy ${key} says no reason`);
        }
      }
      if (mutation) for (const problem of lintMutation(mutation, input.root, input.siblings)) problems.push(`${at}: mutation: ${problem}`);
      for (const source of trace === undefined ? [] : Array.isArray(trace) ? trace : [trace as TraceSource]) {
        const bad = traceProblem(source);
        if (bad) problems.push(`${at}: trace: ${bad}`);
      }
      if (hollowAttested && (!/^[0-9a-f]{7,40}$/.test(hollowAttested.commit) || !/\.test\.tsx?\b/.test(hollowAttested.test))) problems.push(`${at}: hollowAttested names a commit sha and a test file`);
      if (voidReview) {
        if (voidReview.verdict !== "void" && voidReview.verdict !== "have") problems.push(`${at}: voidReview verdict is void or have`);
        if (!text(voidReview.reason)) problems.push(`${at}: voidReview says no reason`);
        if (input.entries[id]?.[0] !== "void" && voidReview.verdict === "void") problems.push(`${at}: voidReview on a node whose status is ${input.entries[id]?.[0]}`);
      }
    }
  });
  for (const id of Object.keys(input.attest ?? {})) {
    if (!region.has(id)) problems.push(`attest ${id}: unknown node`);
    else if (!input.byRegion[region.get(id)!]?.[id]?.mutation) problems.push(`attest ${id}: no mutation spec in r${String(region.get(id)).padStart(2, "0")} — the attestation is orphaned`);
  }
  // Statuses whose reason is the entry's one line.
  let deviationData = 0;
  for (const [id, [status, ours]] of Object.entries(input.entries)) {
    if ((status === "deviation" || status === "deviation-data") && !text(ours)) problems.push(`${id}: ${status} needs a one-line reason`);
    if (status === "deviation-data") deviationData++;
  }
  if (deviationData > input.nodes.length * 0.02) problems.push(`deviation-data on ${deviationData} nodes: more than 2 % of the map (${Math.floor(input.nodes.length * 0.02)})`);
  return problems;
}
