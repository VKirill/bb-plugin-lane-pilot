import { localDateKey, parseDocsSettings } from "../docs";
import type { DocsUnit } from "../docs";
import { DOCS_NIGHT } from "../../contracts";
import { docsUnitRecordKey, readUnitRecord } from "./docs-unit-records";
import { unitLabelOf } from "./docs-unit-steps";
import type { NightlyShared, DocsUnitRecord, UnitInputs } from "./docs-night-state";

  /**
   * One docs unit as a graph run (`lp.docs-night`): the same key is the same run, so a retry after a reload or a second tick finds the run that
   * has the unit and waits for it. Returns the unit's report, the row the pass collects; a run that failed throws, as the unit's code did.
   */
  export async function runDocsUnit(n:NightlyShared,c:{
projectId:string;place:{hostId:string;path:string};basePath?:string;scopes?:string[];localDate?:string;attempt?:number;settings?:Record<string,unknown>;docs?:ReturnType<typeof parseDocsSettings>;base?:string;
    roots:string[];exclude:string[];workspaces:Array<{path:string;name:string;docsDir:string|null}>;prefetch:Map<string,Promise<unknown>>;
    othersWritable:(path:string,self:DocsUnit)=>boolean;assignment?:string},unit:DocsUnit):Promise<Record<string,unknown>> {
    const {ctx,services,unitExtras,activeUnitRuns,docsUnitsFinishing}=n;
    const label=unitLabelOf(unit);
    const recordKey=docsUnitRecordKey(c.projectId,c.place.path,label);
    // A unit with saved progress keeps the run that saved it (an older version's record has none: its night is the key).
    const open=await readUnitRecord(n,recordKey);
    const runKey=open?(open.runKey??`docs-night:${recordKey}:${open.localDate}:0`):`docs-night:${recordKey}:${c.localDate??localDateKey(new Date())}:${c.attempt??1}`;
    unitExtras.set(recordKey,{prefetch:c.prefetch,othersWritable:c.othersWritable});
    try{
      return await startUnitRun(n,{projectId:c.projectId,place:c.place,basePath:c.basePath&&c.basePath!==c.place.path?c.basePath:"",scopes:c.scopes??[],unit,roots:c.roots,exclude:c.exclude,workspaces:c.workspaces,base:c.base??"",runKey,...(c.assignment?{assignment:c.assignment}:{})},recordKey);
    }finally{ unitExtras.delete(recordKey); }
  }

  export async function startUnitRun(n:NightlyShared,i:UnitInputs,recordKey:string):Promise<Record<string,unknown>> {
    const {ctx,services,unitExtras,activeUnitRuns,docsUnitsFinishing}=n;

    const engine=services.workflowEngine;
    const workflow=services.workflowEngine.resolveWorkflow(DOCS_NIGHT);
    if(!workflow) throw new Error(`built-in workflow ${DOCS_NIGHT} is not loaded`);
    const started=engine.start({workflow,key:i.runKey,link:{projectId:i.projectId},inputs:{project_id:i.projectId,host_id:i.place.hostId,path:i.place.path,base_path:i.basePath,scopes:i.scopes,unit:i.unit,
      roots:i.roots,exclude:i.exclude,workspaces:i.workspaces,base:i.base,run_key:i.runKey,...(i.assignment?{assignment:i.assignment}:{})}});
    let summary:Awaited<typeof started.done>;
    try{ summary=await started.done; }
    finally{ docsUnitsFinishing.delete(recordKey); }
    if(summary.status==="succeeded"){
      const row=(summary.output??{}).row;
      if(row&&typeof row==="object") return row as Record<string,unknown>;
      throw new Error(`docs unit run ${summary.runId} gave no report`);
    }
    // The engine stopped at a step boundary (a reload): the run goes on in the next instance, the unit record keeps its progress.
    if(summary.stopped||ctx.isDisposed()) throw new Error("plugin reloaded: the docs unit run goes on in the next instance");
    throw new Error(summary.error??summary.reason??`docs unit run ${summary.status}`);
  }

  /**
   * A unit with saved progress, finished on its own graph run: the run that saved it (or, for a record an older version saved, a run made now) goes on
   * from the record. Safe to call again: the same run is the same run. Returns the unit's report.
   */
  export async function finishDocsUnit(n:NightlyShared,record:DocsUnitRecord,othersWritable:(path:string,self:DocsUnit)=>boolean):Promise<Record<string,unknown>> {
    const {ctx,services,unitExtras,activeUnitRuns,docsUnitsFinishing}=n;

    const key=docsUnitRecordKey(record.projectId,record.place.path,record.label);
    const runKey=record.runKey??`docs-night:${key}:${record.localDate}:0`;
    if(activeUnitRuns.has(runKey)) return {projectId:record.projectId,path:record.place.path,docsDir:record.label,state:"skipped",reason:"already finishing"};
    activeUnitRuns.add(runKey);
    unitExtras.set(key,{prefetch:new Map(),othersWritable});
    try{
      return await startUnitRun(n,{projectId:record.projectId,place:record.place,basePath:record.basePath??"",scopes:[],unit:record.unit,roots:record.roots,exclude:[],workspaces:record.workspaces,base:"",runKey},key);
    }finally{ activeUnitRuns.delete(runKey); unitExtras.delete(key); }
  }
