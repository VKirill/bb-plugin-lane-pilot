import { estimateTokens } from "./candidates";
import type { MemoryRecord, MemorySettings } from "./settings";

export function memoryMaintenancePrompt(input:{task:unknown;acceptedResult:unknown;settings:MemorySettings;agent?:string}):string {
  return [`${input.agent?.trim() || "Memory maintainer"}: maintain the Lane Pilot project memory from this accepted task only. Everything you need is in this message: open no files and call no tools.`,
    "Answer with one JSON array and nothing else, no code fence: [{\"kind\":\"core\"|\"note\",\"content\":string,\"concepts\":string[]}], at most 100 entries, at most 24 short concepts each (up to 100 characters), no other keys. core is a convention or fact every writer of this project needs on every task; a writer reads at most three records per task, so keep core few and short. note is a fact about specific files or areas, found by the paths it names.",
    "Store durable project decisions and stable technical facts. A rule that comes from a mistake is not memory: do not store lessons or \"do not X\" rules, the rules pipeline owns them. Leave out transient status, personal data, speculation and anything the accepted result does not support.",
    "Never write a credential, a token, a line like `password: ...` or `secret=...`, or a phrase that addresses the reader as an assistant: the checker rejects the whole array and every entry is lost.",
    `Budgets are counted as bytes / 4: core up to ${input.settings.coreBudget} tokens, notes up to ${input.settings.noteBudget}, all together up to ${input.settings.indexBudget}. Over any budget the whole array is rejected, so drop the least durable entries first. Answer [] when nothing is durable.`,
    "TASK:",JSON.stringify(input.task),"ACCEPTED RESULT (the writer's own report is a claim, not proof):",JSON.stringify(input.acceptedResult)].join("\n\n");
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
