import { createHash } from "node:crypto";

export const MEMORY_AUDIENCES=["owner","subagent","export"] as const;
export const MEMORY_SEARCH_ENGINES=["auto","fts5","bm25"] as const;
export const MEMORY_PERSONAL_BOTS=["","claude","codex","grok","qwen","kimi","agy","cursor"] as const;
export type MemoryAudience=(typeof MEMORY_AUDIENCES)[number];
export type MemorySearchEngine=(typeof MEMORY_SEARCH_ENGINES)[number];
export type MemoryKind="core"|"note";
export type MemorySettings={enabled:boolean;maintain:boolean;inject:boolean;audience:MemoryAudience;personalBot:string;searchEngine:MemorySearchEngine;coreBudget:number;noteBudget:number;indexBudget:number;contextBudget:number};
export type MemoryCandidate={kind:MemoryKind;content:string;concepts:string[]};
export type MemoryRecord=MemoryCandidate & {id:string;projectId:string;personalBot:string;sourceSha256:string;createdAt:number};

const MAX_BUDGET=1_000_000;
const MAX_ENTRY_BYTES=64_000;
const SECRET_LIKE=/(?:\bsk-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+)/i;
const INSTRUCTION_INJECTION=/(?:ignore (?:all )?(?:previous|prior) instructions|forget (?:all )?(?:previous|prior) instructions|забудь(?:те)? (?:все )?(?:прежние |предыдущие )?инструкции)/i;

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
  return {enabled:bool(raw["memory.enabled"],false,"memory.enabled"),maintain:bool(raw["memory.maintain"],true,"memory.maintain"),inject:bool(raw["memory.inject"],true,"memory.inject"),audience:audience as MemoryAudience,personalBot:personalBot as string,searchEngine:searchEngine as MemorySearchEngine,coreBudget:int(raw["memory.core_budget"],3072,"memory.core_budget"),noteBudget:int(raw["memory.note_budget"],8000,"memory.note_budget"),indexBudget:int(raw["memory.index_budget"],65536,"memory.index_budget"),contextBudget:int(raw["memory.context_budget"],2500,"memory.context_budget")};
}

export function parseMemoryCandidates(raw:unknown,settings:MemorySettings):MemoryCandidate[] {
  if (typeof raw === "string") {
    const text=raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
    try { raw=JSON.parse(text); } catch { throw new Error("memory output must be a JSON array"); }
  }
  if(!Array.isArray(raw)||raw.length>100)throw new Error("memory output must be an array of at most 100 entries");
  const result:MemoryCandidate[]=[];
  let core=0,note=0,index=0;
  for(const value of raw){
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("memory entry must be an object");
    const row=value as Record<string,unknown>;
    if(Object.keys(row).some((key)=>!["kind","content","concepts"].includes(key)))throw new Error("memory entry contains unsupported fields");
    if(row.kind!=="core"&&row.kind!=="note")throw new Error("memory kind must be core or note");
    if(typeof row.content!=="string"||!row.content.trim()||Buffer.byteLength(row.content,"utf8")>MAX_ENTRY_BYTES)throw new Error("memory content is empty or exceeds the 64000 byte limit");
    if(SECRET_LIKE.test(row.content))throw new Error("memory content appears to contain a credential; no memory was saved");
    if(INSTRUCTION_INJECTION.test(row.content))throw new Error("memory content addresses the assistant with an instruction override; no memory was saved");
    if(!Array.isArray(row.concepts)||row.concepts.length>24||row.concepts.some((item)=>typeof item!=="string"||!item.trim()||item.length>100))throw new Error("memory concepts must be up to 24 short strings");
    const entry={kind:row.kind as MemoryKind,content:row.content.trim(),concepts:[...new Set((row.concepts as string[]).map((item)=>item.trim().toLowerCase()))]};
    const tokens=estimateTokens(entry.content);
    if(entry.kind==="core")core+=tokens;else note+=tokens;
    index+=tokens;
    result.push(entry);
  }
  if(core>settings.coreBudget)throw new Error(`memory core budget exceeded: ${core}/${settings.coreBudget} tokens`);
  if(note>settings.noteBudget)throw new Error(`memory note budget exceeded: ${note}/${settings.noteBudget} tokens`);
  if(index>settings.indexBudget)throw new Error(`memory index budget exceeded: ${index}/${settings.indexBudget} tokens`);
  return result;
}

export function estimateTokens(text:string):number { return Math.ceil(Buffer.byteLength(text,"utf8")/4); }

export function memoryRecordId(projectId:string,kind:MemoryKind,content:string,personalBot=""):string {
  return createHash("sha256").update(`${projectId}\0${personalBot ? `bot:${personalBot}\0` : ""}${kind}\0${content.trim().replace(/\s+/g," ").toLowerCase()}`).digest("hex");
}

export function memoryMaintenancePrompt(input:{task:unknown;acceptedResult:unknown;settings:MemorySettings;agent?:string}):string {
  return [`${input.agent?.trim() || "Memory maintainer"}: maintain the Lane Pilot project memory corpus from this accepted task only.`,
    "Return JSON array of {kind:'core'|'note',content:string,concepts:string[]}; do not edit files or execute tools.",
    "Store durable project decisions, stable technical facts, and reusable lessons only. Exclude transient status, secrets, credentials, personal data, speculative claims, and facts not supported by the accepted result.",
    `Audience=${input.settings.audience}; core budget=${input.settings.coreBudget} tokens; note budget=${input.settings.noteBudget} tokens; total index budget=${input.settings.indexBudget} tokens. Return [] if nothing is durable.`,
    "TASK:",JSON.stringify(input.task),"ACCEPTED RESULT:",JSON.stringify(input.acceptedResult)].join("\n\n");
}

export function memoryContext(records:MemoryRecord[],taskText:string,budget:number):{text:string;records:MemoryRecord[];estimatedTokens:number} {
  const terms=new Set(tokens(taskText));
  const ranked=records.map((record)=>({record,score:tokens(`${record.content} ${record.concepts.join(" ")}`).reduce((sum,token)=>sum+(terms.has(token)?1:0),0)}))
    .filter((item)=>item.score>0).sort((a,b)=>b.score-a.score||b.record.createdAt-a.record.createdAt||a.record.id.localeCompare(b.record.id));
  const selected:MemoryRecord[]=[];let used=0;
  for(const item of ranked){const size=estimateTokens(item.record.content);if(used+size>budget)continue;selected.push(item.record);used+=size;}
  const text=selected.map((item)=>`- [${item.kind}; concepts=${item.concepts.join(", ")}] ${item.content}`).join("\n");
  return {text,records:selected,estimatedTokens:estimateTokens(text)};
}

function tokens(text:string):string[] { return (text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)??[]); }
