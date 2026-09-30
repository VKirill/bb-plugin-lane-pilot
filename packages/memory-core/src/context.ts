import { estimateTokens } from "./candidates";
import type { MemoryRecord, MemorySettings } from "./settings";

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
