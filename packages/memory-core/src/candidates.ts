import { createHash } from "node:crypto";
import type { MemoryCandidate, MemoryKind, MemorySettings } from "./settings";

const MAX_ENTRY_BYTES=64_000;
/** The concepts the maintainer prompt tells a note to carry for reviewers (context.ts). */
const REVIEW_CONCEPTS=new Set(["review","pitfall","invariant","security","regression"]);
const KNOWN_FIELDS=new Set(["kind","content","concepts","supersedes","valid_until","valid_from"]);
const SECRET_LIKE=/(?:\bsk-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+)/i;
const INSTRUCTION_INJECTION=/(?:ignore (?:all )?(?:previous|prior|above) instructions|forget (?:all )?(?:previous|prior) instructions|disregard (?:all )?(?:previous|prior|above)|you are now\b|^\s*#{0,6}\s*(?:system|assistant)\s*:|<\/?(?:system|instructions)>|забудь(?:те)? (?:все )?(?:прежние |предыдущие )?инструкции|игнорируй (?:все )?(?:прежние |предыдущие )?инструкции)/im;

/**
 * Why a text must not be stored as memory: it looks like a credential, or it talks to the assistant as an
 * instruction override. Every path that writes memory checks this — maintainer output, imports, rules.
 */
export function memoryContentIssue(content:string):string|null {
  if(SECRET_LIKE.test(content))return "memory content appears to contain a credential; no memory was saved";
  if(INSTRUCTION_INJECTION.test(content))return "memory content addresses the assistant with an instruction override; no memory was saved";
  return null;
}

/** Concrete claims a note can make: file paths, versions, numbers, quoted identifiers. */
const SPECIFIC=/[\w.-]+\/[\w./-]+|v?\d+\.\d+(?:\.\d+)?|\b\d{2,}\b/g;

/**
 * The cheap verifier pass over a maintainer candidate (arXiv #7 TRUSTMEM): every concrete claim the entry makes —
 * a path, a version, a number — must appear in the accepted result it claims to summarize. An entry with no concrete
 * claims is a paraphrase and passes; one that invents a port or a file name is dropped before it reaches the store.
 */
export function memoryEntrySupported(content:string, sourceText:string):boolean {
  const claims=content.match(SPECIFIC)??[];
  if(!claims.length)return true;
  const source=sourceText.toLowerCase();
  return claims.every((claim)=>source.includes(claim.toLowerCase()));
}

export function estimateTokens(text:string):number { return Math.ceil(Buffer.byteLength(text,"utf8")/4); }

/**
 * Identity of one fact. The historical hash (project, bot, kind, text) stays for a shared subagent fact at the project
 * root, so a restated root fact still finds the row the hub already stores. Audience or a section chain is part of the
 * hash: the same words in another section or for another audience are a different fact, and a later write cannot widen
 * the row that already exists.
 */
export function memoryRecordId(projectId:string,kind:MemoryKind,content:string,personalBot="",audience="",scope:readonly string[]=[]):string {
  const normalized=content.trim().replace(/\s+/g," ").toLowerCase();
  const base=`${projectId}\0${personalBot ? `bot:${personalBot}\0` : ""}${kind}\0${normalized}`;
  const namespaced=scope.length>0||(audience!==""&&audience!=="subagent");
  const body=namespaced?`${base}\0aud:${audience}\0scope:${JSON.stringify([...scope])}`:base;
  return createHash("sha256").update(body).digest("hex");
}

/** The array in a maintainer's text: the whole text, a fenced block (last first), or the outermost brackets after a preamble. */
function arrayFromText(raw:string):unknown {
  const text=raw.trim();
  const candidates=[text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"")];
  for(const block of [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi)].reverse())candidates.push(block[1]!);
  const start=text.indexOf("["),end=text.lastIndexOf("]");
  if(start>=0&&end>start)candidates.push(text.slice(start,end+1));
  for(const candidate of candidates){
    try { const value=JSON.parse(candidate.trim()); if(Array.isArray(value))return value; } catch { /* next reading */ }
  }
  throw new Error("memory output must be a JSON array");
}

export function parseMemoryCandidates(raw:unknown,settings:MemorySettings):MemoryCandidate[] {
  if (typeof raw === "string") raw=arrayFromText(raw);
  if(!Array.isArray(raw)||raw.length>100)throw new Error("memory output must be an array of at most 100 entries");
  const result:MemoryCandidate[]=[];
  let note=0,index=0;
  for(const value of raw){
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("memory entry must be an object");
    const row={...value} as Record<string,unknown>;
    // A stray key used to refuse the whole array (hub 2026-10-27: `"review": true`, `"concepts_extra": []`).
    // The concept the prompt names, written as `"review": true`, is that concept; an empty extra carries nothing.
    for(const key of Object.keys(row)){
      if(KNOWN_FIELDS.has(key))continue;
      const extra=row[key];
      if(REVIEW_CONCEPTS.has(key)&&extra===true&&Array.isArray(row.concepts)){row.concepts=[...row.concepts as unknown[],key];delete row[key];}
      else if(extra===null||extra===false||extra===""||(Array.isArray(extra)&&!extra.length))delete row[key];
    }
    if(Object.keys(row).some((key)=>!KNOWN_FIELDS.has(key)))throw new Error("memory entry contains unsupported fields");
    if(row.kind!=="core"&&row.kind!=="note")throw new Error("memory kind must be core or note");
    if(typeof row.content!=="string"||!row.content.trim()||Buffer.byteLength(row.content,"utf8")>MAX_ENTRY_BYTES)throw new Error("memory content is empty or exceeds the 64000 byte limit");
    const issue=memoryContentIssue(row.content);
    if(issue)throw new Error(issue);
    if(!Array.isArray(row.concepts)||row.concepts.length>24||row.concepts.some((item)=>typeof item!=="string"||!item.trim()||item.length>100))throw new Error("memory concepts must be up to 24 short strings");
    if(row.supersedes!==undefined&&(!Array.isArray(row.supersedes)||row.supersedes.length>5||row.supersedes.some((item)=>typeof item!=="string"||!/^[0-9a-f]{12,64}$/.test(item))))throw new Error("memory supersedes must be up to 5 record ids (12 to 64 hex characters)");
    if(row.valid_from!==undefined&&(typeof row.valid_from!=="string"||!/\d{4}-\d{2}-\d{2}/.test(row.valid_from)||Number.isNaN(Date.parse(row.valid_from))))throw new Error("memory valid_from must be an ISO date like 2026-01-01");
    if(row.valid_until!==undefined&&(typeof row.valid_until!=="string"||!/^\d{4}-\d{2}-\d{2}/.test(row.valid_until)||Number.isNaN(Date.parse(row.valid_until))))throw new Error("memory valid_until must be an ISO date like 2026-12-31");
    const entry:MemoryCandidate={kind:row.kind as MemoryKind,content:row.content.trim(),concepts:[...new Set((row.concepts as string[]).map((item)=>item.trim().toLowerCase()))],
      ...(row.supersedes?.length?{supersedes:row.supersedes as string[]}:{}),...(row.valid_until!==undefined?{validUntil:Date.parse(row.valid_until as string)}:{}),...(row.valid_from!==undefined?{validFrom:Date.parse(row.valid_from as string)}:{})};
    const tokens=estimateTokens(entry.content);
    // Core over this batch's core budget is not a refusal. The maintainer door
    // (storeMemoryRecordsKeepingOverflow) stores what does not fit as a note; throwing here
    // used to drop the notes of the same batch and turn lp.after-accept red.
    if(entry.kind!=="core")note+=tokens;
    index+=tokens;
    result.push(entry);
  }
  if(note>settings.noteBudget)throw new Error(`memory note budget exceeded: ${note}/${settings.noteBudget} tokens`);
  if(index>settings.indexBudget)throw new Error(`memory index budget exceeded: ${index}/${settings.indexBudget} tokens`);
  return result;
}
