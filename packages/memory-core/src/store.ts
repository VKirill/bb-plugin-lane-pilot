import type Database from "better-sqlite3";
import { memoryRecordId } from "./candidates";
import type { MemoryAudience, MemoryCandidate, MemoryKind, MemoryRecord, MemorySearchEngine } from "./settings";

/** The better-sqlite3 surface this package needs; BB's `bb.storage.database()` satisfies it. */
export type MemoryDatabase = Pick<Database.Database, "prepare" | "transaction">;

/** Columns the package expects; the owning plugin ships the migration. */
export const MEMORY_SCHEMA = {
  table: "lane_pilot_memory",
  fts: "lane_pilot_memory_fts",
  columns: ["id", "project_id", "personal_bot", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at"],
} as const;

export function storeMemoryRecords(db:MemoryDatabase,input:{projectId:string;personalBot?:string;audience:MemoryAudience;sourceSha256:string;entries:MemoryCandidate[];coreBudget:number;noteBudget:number;indexBudget:number}):{records:MemoryRecord[];insertedIds:string[]} {
  return db.transaction(()=>{
    const personalBot=input.personalBot??"";
    const existing=db.prepare("SELECT kind,content FROM lane_pilot_memory WHERE project_id=? AND personal_bot=?").all(input.projectId,personalBot) as Array<{kind:MemoryKind;content:string}>;
    const ids=new Set(existing.map((row)=>memoryRecordId(input.projectId,row.kind,row.content,personalBot)));
    const pending=input.entries.filter((entry)=>!ids.has(memoryRecordId(input.projectId,entry.kind,entry.content,personalBot)));
    const estimate=(text:string)=>Math.ceil(Buffer.byteLength(text,"utf8")/4);
    const core=existing.filter((row)=>row.kind==="core").reduce((sum,row)=>sum+estimate(row.content),0)+pending.filter((row)=>row.kind==="core").reduce((sum,row)=>sum+estimate(row.content),0);
    const note=existing.filter((row)=>row.kind==="note").reduce((sum,row)=>sum+estimate(row.content),0)+pending.filter((row)=>row.kind==="note").reduce((sum,row)=>sum+estimate(row.content),0);
    const total=core+note;
    if(core>input.coreBudget)throw new Error(`memory core budget exceeded: ${core}/${input.coreBudget} tokens`);
    if(note>input.noteBudget)throw new Error(`memory note budget exceeded: ${note}/${input.noteBudget} tokens`);
    if(total>input.indexBudget)throw new Error(`memory index budget exceeded: ${total}/${input.indexBudget} tokens`);
    const insert=db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at)
      VALUES(@id,@projectId,@personalBot,@kind,@audience,@content,@conceptsJson,@sourceSha256,@createdAt)
      ON CONFLICT(project_id,id) DO NOTHING`);
    const fts=db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES(?,?,?,?)");
    const now=Date.now();
    const insertedIds:string[]=[];
    for(const entry of pending){
      const id=memoryRecordId(input.projectId,entry.kind,entry.content,personalBot);
      const conceptsJson=JSON.stringify(entry.concepts);
      insert.run({id,projectId:input.projectId,personalBot,kind:entry.kind,audience:input.audience,content:entry.content,conceptsJson,sourceSha256:input.sourceSha256,createdAt:now});
      fts.run(id,input.projectId,entry.content,entry.concepts.join(" "));
      insertedIds.push(id);
    }
    const records=(db.prepare("SELECT id,project_id AS projectId,personal_bot AS personalBot,kind,audience,content,concepts_json AS conceptsJson,source_sha256 AS sourceSha256,created_at AS createdAt FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? ORDER BY created_at DESC").all(input.projectId,personalBot) as Array<{id:string;projectId:string;personalBot:string;kind:MemoryKind;audience:string;content:string;conceptsJson:string;sourceSha256:string;createdAt:number}>).map((row)=>({id:row.id,projectId:row.projectId,personalBot:row.personalBot,kind:row.kind,content:row.content,concepts:JSON.parse(row.conceptsJson) as string[],sourceSha256:row.sourceSha256,createdAt:row.createdAt}));
    return {records,insertedIds};
  }).immediate();
}

export function searchMemoryRecords(db:MemoryDatabase,projectId:string,query:string,limit:number,engine:MemorySearchEngine,audience:MemoryAudience="subagent",personalBot=""):MemoryRecord[] {
  const tokens=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)??[])].slice(0,32);
  if(tokens.length===0||limit<=0)return [];
  let rows:Array<{id:string;project_id:string;personal_bot:string;kind:MemoryKind;content:string;concepts_json:string;source_sha256:string;created_at:number}>;
  if(engine!=="bm25"){
    const match=tokens.map((word)=>`"${word.replaceAll('"','')}"`).join(" OR ");
    rows=db.prepare(`SELECT m.id,m.project_id,m.personal_bot,m.kind,m.content,m.concepts_json,m.source_sha256,m.created_at
      FROM lane_pilot_memory_fts f JOIN lane_pilot_memory m ON m.id=f.id AND m.project_id=f.project_id
      WHERE lane_pilot_memory_fts MATCH ? AND f.project_id=? AND m.audience=? AND m.personal_bot=?
      ORDER BY bm25(lane_pilot_memory_fts) LIMIT ?`).all(match,projectId,audience,personalBot,limit) as typeof rows;
  } else {
    const all=db.prepare("SELECT id,project_id,personal_bot,kind,content,concepts_json,source_sha256,created_at FROM lane_pilot_memory WHERE project_id=? AND audience=? AND personal_bot=?").all(projectId,audience,personalBot) as typeof rows;
    const score=(text:string)=>tokens.reduce((sum,token)=>sum+(text.toLowerCase().split(token).length-1),0);
    rows=all.map((row)=>({...row,_score:score(`${row.content} ${row.concepts_json}`)})).filter((row)=>row._score>0).sort((a,b)=>b._score-a._score||b.created_at-a.created_at).slice(0,limit);
  }
  return rows.map((row)=>({id:row.id,projectId:row.project_id,personalBot:row.personal_bot,kind:row.kind,content:row.content,concepts:JSON.parse(row.concepts_json) as string[],sourceSha256:row.source_sha256,createdAt:row.created_at}));
}
