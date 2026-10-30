export const MEMORY_AUDIENCES=["owner","subagent","export"] as const;
export const MEMORY_SEARCH_ENGINES=["auto","fts5","bm25"] as const;
export const MEMORY_PERSONAL_BOTS=["","claude","codex","grok","qwen","kimi","agy","cursor"] as const;
export type MemoryAudience=(typeof MEMORY_AUDIENCES)[number];
export type MemorySearchEngine=(typeof MEMORY_SEARCH_ENGINES)[number];
export type MemoryKind="core"|"note";
export type MemorySettings={enabled:boolean;maintain:boolean;inject:boolean;audience:MemoryAudience;personalBot:string;searchEngine:MemorySearchEngine;coreBudget:number;noteBudget:number;indexBudget:number;contextBudget:number;maintainEvery:number;salienceMin?:number;packMode?:"off"|"shadow"|"adapter"|"canary";queryFloor?:boolean;projectKind?:"auto"|"standalone"|"umbrella"};
/** active: mixed into briefs; superseded: a newer record replaced it; expired: past its date, evicted for budget, or its file went stale. A hidden record is kept, never mixed. */
export type MemoryStatus="active"|"superseded"|"expired";
/** confirmed: written by the maintainer, a rule, or seen from two sources; observed: one session or import wrote it and nothing corroborated it yet. */
export type MemoryTrust="confirmed"|"observed";
export type MemoryCore={kind:MemoryKind;content:string;concepts:string[]};
export type MemoryCandidate=MemoryCore & {
  /** Ids (or 12+ character prefixes) of active records this one replaces. */
  supersedes?:string[];
  /** Epoch ms after which the fact no longer holds. */
  validUntil?:number;
  /** Epoch ms when the fact began to hold; defaults to the write time. */
  validFrom?:number;
  /** The file record this came from, so a later import can tell the record went stale. */
  sourceFileId?:string;
};
export type MemoryRecord=MemoryCore & {id:string;projectId:string;personalBot:string;sourceSha256:string;createdAt:number;
  status?:MemoryStatus;trust?:MemoryTrust;validUntil?:number|null;validFrom?:number|null;supersededBy?:string|null;sourceFileId?:string|null;
  /** How often the record was mixed into a brief, how many of those attempts were accepted, and when it was last mixed. */
  useCount?:number;acceptedCount?:number;lastUsedAt?:number|null;
  /** Hash of the files the note named when it was written. Absent: the write could not read them, so a later brief does not treat the note as drifted. */
  fileFingerprint?:string|null;
  /** The accepted task this record was distilled from. */
  originTaskId?:string|null;
  /** Who vouched for the fact: one entry per independent source (arXiv #21). */
  verification?:Array<{by:string;sha:string;at:number}>};

export const MAX_BUDGET=1_000_000;
/** The settings keys `parseMemorySettings` reads. */
export const MEMORY_SETTING_KEYS=["memory.enabled","memory.maintain","memory.inject","memory.audience","memory.personal_bot","memory.search_engine","memory.core_budget","memory.note_budget","memory.index_budget","memory.context_budget","memory.maintain_every","memory.salience_min","memory.pack_mode","memory.query_floor","memory.project_kind"] as const;
/** Tags that mark a note as something a reviewer or critic should check: a pitfall, an invariant, a security or regression concern. */
export const REVIEWER_CONCEPTS=["review","reviewer","pitfall","gotcha","invariant","regression","security"] as const;

function bool(value:unknown,fallback:boolean,name:string):boolean {
  if(value==null)return fallback;
  if(typeof value==="boolean")return value;
  if(["true","1","yes","on"].includes(String(value).toLowerCase()))return true;
  if(["false","0","no","off"].includes(String(value).toLowerCase()))return false;
  throw new Error(`${name} must be boolean`);
}
function int(value:unknown,fallback:number,name:string):number {
  if(value==null)return fallback;
  const n=typeof value==="number"?value:typeof value==="string"&&/^\d+$/.test(value)?Number(value):NaN;
  if(!Number.isSafeInteger(n)||n<1||n>MAX_BUDGET)throw new Error(`${name} must be an integer from 1 to ${MAX_BUDGET}`);
  return n;
}

export function parseMemorySettings(raw:Record<string,unknown>):MemorySettings {
  const audience=raw["memory.audience"]??"subagent";
  const personalBot=raw["memory.personal_bot"]??"";
  const searchEngine=raw["memory.search_engine"]??"auto";
  if(!(MEMORY_AUDIENCES as readonly unknown[]).includes(audience))throw new Error("memory.audience must be owner, subagent, or export");
  if(!(MEMORY_PERSONAL_BOTS as readonly unknown[]).includes(personalBot))throw new Error("memory.personal_bot must be empty, claude, codex, grok, qwen, kimi, agy, or cursor");
  if(!(MEMORY_SEARCH_ENGINES as readonly unknown[]).includes(searchEngine))throw new Error("memory.search_engine must be auto, fts5, or bm25");
  return {enabled:bool(raw["memory.enabled"],true,"memory.enabled"),maintain:bool(raw["memory.maintain"],true,"memory.maintain"),inject:bool(raw["memory.inject"],true,"memory.inject"),audience:audience as MemoryAudience,personalBot:personalBot as string,searchEngine:searchEngine as MemorySearchEngine,coreBudget:int(raw["memory.core_budget"],3072,"memory.core_budget"),noteBudget:int(raw["memory.note_budget"],24000,"memory.note_budget"),indexBudget:int(raw["memory.index_budget"],65536,"memory.index_budget"),contextBudget:int(raw["memory.context_budget"],2500,"memory.context_budget"),maintainEvery:Math.max(1,int(raw["memory.maintain_every"],3,"memory.maintain_every")),salienceMin:Math.min(100,Math.max(0,int(raw["memory.salience_min"],40,"memory.salience_min"))),packMode:(["off","shadow","adapter","canary"] as const).includes(raw["memory.pack_mode"] as never)?raw["memory.pack_mode"] as "off"|"shadow"|"adapter"|"canary":"shadow",queryFloor:raw["memory.query_floor"]!=="off",projectKind:(["auto","standalone","umbrella"] as const).includes(raw["memory.project_kind"] as never)?raw["memory.project_kind"] as "auto"|"standalone"|"umbrella":"auto"};
}
