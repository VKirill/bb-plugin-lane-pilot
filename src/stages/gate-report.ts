import { z } from "zod";
import type { StageEventRow, GateEventRow, LanePilotDatabase } from "../database";
import { GATE_CATEGORIES, listGateEvents, listStageEvents } from "../database";
import { STAGE_IDS, type StageId, type StageState } from "./contract";

export const gateReportInputSchema = z.object({
  projectId:z.string().min(1),
  days:z.number().int().min(1).max(365).default(7),
  stageId:z.enum(STAGE_IDS).optional(),
  gate:z.enum(GATE_CATEGORIES).optional(),
  now:z.number().int().nonnegative().optional(),
}).strict();
export type GateReportInput = z.input<typeof gateReportInputSchema>;

export type GateReport = {
  schemaVersion:1;
  projectId:string;
  from:number;
  to:number;
  totalEvents:number;
  totalGateEvents:number;
  byStage:Array<{stageId:StageId;total:number;byState:Partial<Record<StageState,number>>}>;
  byGate:Array<{gate:(typeof GATE_CATEGORIES)[number];total:number;byStatus:Partial<Record<GateEventRow["status"],number>>}>;
  recentBlockers:Array<{runId:string;taskId:string;stageId:StageId;state:"failed"|"blocked";attempt:number;occurredAt:number}>;
  recentGateBlockers:Array<{runId:string;taskId:string;gate:GateEventRow["gate"];status:"rejected"|"failed";attempt:number;occurredAt:number}>;
};

export function buildGateReport(input:GateReportInput,events:StageEventRow[],gateEvents:GateEventRow[]=[]):GateReport {
  const parsed=gateReportInputSchema.parse(input);
  const to=parsed.now??Date.now(), from=to-parsed.days*24*60*60*1000;
  const filtered=events.filter((event)=>event.projectId===parsed.projectId&&event.occurredAt>=from&&event.occurredAt<=to&&(!parsed.stageId||event.stageId===parsed.stageId));
  const filteredGates=gateEvents.filter((event)=>event.projectId===parsed.projectId&&event.occurredAt>=from&&event.occurredAt<=to&&(!parsed.gate||event.gate===parsed.gate));
  const stages=new Map<StageId,{total:number;byState:Partial<Record<StageState,number>>}>();
  for(const event of filtered){
    const row=stages.get(event.stageId)??{total:0,byState:{}};
    row.total++;
    row.byState[event.state]=(row.byState[event.state]??0)+1;
    stages.set(event.stageId,row);
  }
  return {
    schemaVersion:1,projectId:parsed.projectId,from,to,totalEvents:filtered.length,totalGateEvents:filteredGates.length,
    byStage:[...stages.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([stageId,value])=>({stageId,...value})),
    byGate:GATE_CATEGORIES.map((gate)=>{
      const gateRows=filteredGates.filter((event)=>event.gate===gate);
      const byStatus:Partial<Record<GateEventRow["status"],number>>={};
      for(const event of gateRows) byStatus[event.status]=(byStatus[event.status]??0)+1;
      return gateRows.length?{gate,total:gateRows.length,byStatus}:null;
    }).filter((row)=>row!==null),
    recentBlockers:filtered.filter((event)=>event.state==="failed"||event.state==="blocked")
      .sort((a,b)=>b.occurredAt-a.occurredAt||b.id-a.id).slice(0,20)
      .map(({runId,taskId,stageId,state,attempt,occurredAt})=>({runId,taskId,stageId,state:state as "failed"|"blocked",attempt,occurredAt})),
    recentGateBlockers:filteredGates.filter((event)=>event.status==="rejected"||event.status==="failed")
      .sort((a,b)=>b.occurredAt-a.occurredAt||b.id-a.id).slice(0,20)
      .map(({runId,taskId,gate,status,attempt,occurredAt})=>({runId,taskId,gate,status:status as "rejected"|"failed",attempt,occurredAt})),
  };
}

export function readGateReport(db:LanePilotDatabase,input:GateReportInput):GateReport {
  const parsed=gateReportInputSchema.parse(input),now=parsed.now??Date.now();
  const events=listStageEvents(db,{projectId:parsed.projectId,since:now-parsed.days!*24*60*60*1000,stageId:parsed.stageId});
  const gateEvents=listGateEvents(db,{projectId:parsed.projectId,since:now-parsed.days!*24*60*60*1000,gate:parsed.gate});
  return buildGateReport({...parsed,now},events,gateEvents);
}
