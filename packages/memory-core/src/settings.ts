export const MEMORY_AUDIENCES=["owner","subagent","export"] as const;
export const MEMORY_SEARCH_ENGINES=["auto","fts5","bm25"] as const;
export const MEMORY_PERSONAL_BOTS=["","claude","codex","grok","qwen","kimi","agy","cursor"] as const;
export type MemoryAudience=(typeof MEMORY_AUDIENCES)[number];
export type MemorySearchEngine=(typeof MEMORY_SEARCH_ENGINES)[number];
export type MemoryKind="core"|"note";
export type MemorySettings={enabled:boolean;maintain:boolean;inject:boolean;audience:MemoryAudience;personalBot:string;searchEngine:MemorySearchEngine;coreBudget:number;noteBudget:number;indexBudget:number;contextBudget:number};
export type MemoryCandidate={kind:MemoryKind;content:string;concepts:string[]};
export type MemoryRecord=MemoryCandidate & {id:string;projectId:string;personalBot:string;sourceSha256:string;createdAt:number};

export const MAX_BUDGET=1_000_000;

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
  return {enabled:bool(raw["memory.enabled"],true,"memory.enabled"),maintain:bool(raw["memory.maintain"],true,"memory.maintain"),inject:bool(raw["memory.inject"],true,"memory.inject"),audience:audience as MemoryAudience,personalBot:personalBot as string,searchEngine:searchEngine as MemorySearchEngine,coreBudget:int(raw["memory.core_budget"],3072,"memory.core_budget"),noteBudget:int(raw["memory.note_budget"],8000,"memory.note_budget"),indexBudget:int(raw["memory.index_budget"],65536,"memory.index_budget"),contextBudget:int(raw["memory.context_budget"],2500,"memory.context_budget")};
}
