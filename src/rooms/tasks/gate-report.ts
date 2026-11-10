import { z } from "zod";
import type { StageEventRow, GateEventRow, LanePilotDatabase } from "../storage";
import { GATE_CATEGORIES, listGateEvents, listStageEvents } from "../storage";
import { STAGE_IDS, type StageId, type StageState } from "@lane-pilot/contracts";

export const gateReportInputSchema = z.object({
  projectId:z.string().min(1),
  days:z.number().int().min(1).max(365).default(7),
  stageId:z.enum(STAGE_IDS).optional(),
  gate:z.enum(GATE_CATEGORIES).optional(),
  now:z.number().int().nonnegative().optional(),
}).strict();
export type GateReportInput = z.input<typeof gateReportInputSchema>;

/** A false-alarm ack (SMA k_v_gates): a person marked one firing as not the gate's fault; it stops counting against the gate. */
export type GateAck = { eventId:number; why:string; by:string; at:number };

export type GateReport = {
  schemaVersion:1;
  projectId:string;
  from:number;
  to:number;
  totalEvents:number;
  totalGateEvents:number;
  byStage:Array<{stageId:StageId;total:number;byState:Partial<Record<StageState,number>>}>;
  byGate:Array<{gate:(typeof GATE_CATEGORIES)[number];total:number;byStatus:Partial<Record<GateEventRow["status"],number>>;falseAlarms?:number}>;
  /** Per task: did every gate category pass on the attempt that was accepted (the full-gate marker). */
  fullGate?:Array<{runId:string;taskId:string;full:boolean}>;
  recentBlockers:Array<{runId:string;taskId:string;stageId:StageId;state:"failed"|"blocked";attempt:number;occurredAt:number}>;
  recentGateBlockers:Array<{runId:string;taskId:string;gate:GateEventRow["gate"];status:"rejected"|"failed";attempt:number;occurredAt:number}>;
};

export function buildGateReport(input:GateReportInput,events:StageEventRow[],gateEvents:GateEventRow[]=[],acks:readonly GateAck[]=[]):GateReport {
  const acked=new Set(acks.map((ack)=>ack.eventId));
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
      // A firing a person acked was a false alarm: still counted in byStatus, but named and out of the blockers.
      const falseAlarms=gateRows.filter((event)=>(event.status==="rejected"||event.status==="failed")&&acked.has(event.id)).length;
      return gateRows.length?{gate,total:gateRows.length,byStatus,falseAlarms}:null;
    }).filter((row)=>row!==null),
    fullGate:[...new Set(filteredGates.map((event)=>`${event.runId}${event.taskId}`))].map((key)=>{
      const [runId,taskId]=key.split("") as [string,string];
      const rows=filteredGates.filter((event)=>event.taskId===taskId&&event.runId===runId);
      // The accepted attempt: the attempt whose accept gate passed, else the task's newest attempt on record.
      const attempt=rows.filter((event)=>event.gate==="accept"&&event.status==="passed").map((event)=>event.attempt).sort((a,b)=>b-a)[0]??Math.max(...rows.map((event)=>event.attempt));
      const passed=new Set(rows.filter((event)=>event.attempt===attempt&&event.status==="passed").map((event)=>event.gate));
      return {runId,taskId,full:GATE_CATEGORIES.every((gate)=>passed.has(gate))};
    }),
    recentBlockers:filtered.filter((event)=>event.state==="failed"||event.state==="blocked")
      .sort((a,b)=>b.occurredAt-a.occurredAt||b.id-a.id).slice(0,20)
      .map(({runId,taskId,stageId,state,attempt,occurredAt})=>({runId,taskId,stageId,state:state as "failed"|"blocked",attempt,occurredAt})),
    recentGateBlockers:filteredGates.filter((event)=>(event.status==="rejected"||event.status==="failed")&&!acked.has(event.id))
      .sort((a,b)=>b.occurredAt-a.occurredAt||b.id-a.id).slice(0,20)
      .map(({runId,taskId,gate,status,attempt,occurredAt})=>({runId,taskId,gate,status:status as "rejected"|"failed",attempt,occurredAt})),
  };
}

/** The kv key the false-alarm acks live under (`bb lane-pilot gates ack <event-id> --why` writes them). */
export const GATE_ACKS_KEY = "gates:acks";

export async function readGateReport(db:LanePilotDatabase,input:GateReportInput,kv?:{get(key:string):Promise<unknown>}):Promise<GateReport> {
  const parsed=gateReportInputSchema.parse(input),now=parsed.now??Date.now();
  const events=listStageEvents(db,{projectId:parsed.projectId,since:now-parsed.days!*24*60*60*1000,stageId:parsed.stageId});
  const gateEvents=listGateEvents(db,{projectId:parsed.projectId,since:now-parsed.days!*24*60*60*1000,gate:parsed.gate});
  const stored=kv?await kv.get(GATE_ACKS_KEY).catch(()=>null):null;
  const acks=stored&&typeof stored==="object"?Object.values(stored as Record<string,GateAck>):[];
  return buildGateReport({...parsed,now},events,gateEvents,acks);
}
