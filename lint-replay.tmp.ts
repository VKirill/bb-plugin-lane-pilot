import { lintContract, repeatedRunner } from "/home/ubuntu/BB-service/wt/batch2/src/rooms/tasks/server/contract-lint.ts";
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("/tmp/lp-contracts-14d-p.json","utf8")) as Array<{contract_json:string; project_id:string}>;
const tally = new Map<string,number>(); let tasks=0;
const samples = new Map<string,string>();
let repeated=0, ownsCand=0, filesCand=0, accByMode = {quick:0,standard:0,full:0};
const concrete = (p:string) => { const n=p.replace(/^\.\//,"").replace(/\/$/,""); return !n||/[*?[]/.test(n)||!/(?:^|\/)[^/]*\.[A-Za-z0-9]{1,8}$/.test(n) ? null : n; };
for (const row of rows) {
  let task: any; try { task = JSON.parse(row.contract_json); } catch { continue; }
  tasks++;
  const { errors } = lintContract({ task, workspacePath:"/nonexistent", hostId:"h", qualityMode:"standard", kinds:null, sandboxUnsafe:[], openTasks:[], deadDependencies:[] });
  for (const e of errors) { tally.set(e.code,(tally.get(e.code)??0)+1); if(!samples.has(e.code)) samples.set(e.code,`${task.id}: ${e.message.slice(0,140)}`); }
  // structural candidates for the kinds/gate-dependent rules
  const creates = new Set([...(task.expected_outputs??[]), ...(task.files??[]).filter((f:any)=>f.action==="create").map((f:any)=>f.path)].map((p:string)=>p.replace(/^\.\//,"")));
  if ((task.owns_paths??[]).some((p:string)=>{ const c=concrete(p); return c && !creates.has(c); })) ownsCand++;
  if ((task.files??[]).some((f:any)=>f.action!=="create" && concrete(f.path) && !creates.has(concrete(f.path)!))) filesCand++;
  if ((task.verification??[]).some((v:any)=>repeatedRunner(v.command))) repeated++;
}
console.log(`tasks ${tasks}`);
for (const [code,n] of [...tally.entries()].sort((a,b)=>b[1]-a[1])) console.log(`${String(n).padStart(4)}  ${code}\n      ${samples.get(code)}`);
console.log(`\nstructural candidates (need machine state to decide):`);
console.log(`${ownsCand}  owns_missing candidates (concrete owns_path not declared created)`);
console.log(`${filesCand}  output_missing candidates (files[] modify/delete of path not created)`);
console.log(`${repeated}  repeated_runner_chain candidates (fires only with an integration gate)`);
