import { describe,expect,it } from "vitest";
import { buildGateReport } from "../../src/stages/gate-report";
import type { GateEventRow, StageEventRow } from "../../src/database";

const events:StageEventRow[]=[
  {id:1,projectId:"p",runId:"r1",taskId:"t1",stageId:"plan-critique",state:"passed",inputSha256:"a".repeat(64),outputSha256:"b".repeat(64),attempt:1,occurredAt:90},
  {id:2,projectId:"p",runId:"r1",taskId:"t1",stageId:"writer-agent",state:"blocked",inputSha256:"a".repeat(64),outputSha256:null,attempt:1,occurredAt:95},
  {id:3,projectId:"p",runId:"r2",taskId:"t2",stageId:"writer-agent",state:"failed",inputSha256:"a".repeat(64),outputSha256:null,attempt:2,occurredAt:96},
  {id:4,projectId:"other",runId:"r3",taskId:"t3",stageId:"writer-agent",state:"failed",inputSha256:"a".repeat(64),outputSha256:null,attempt:1,occurredAt:97},
  {id:5,projectId:"p",runId:"old",taskId:"old",stageId:"writer-agent",state:"failed",inputSha256:"a".repeat(64),outputSha256:null,attempt:1,occurredAt:-86400000},
];
const gateEvents:GateEventRow[]=[
  {id:1,projectId:"p",runId:"r1",taskId:"t1",gate:"owns-paths",status:"passed",inputSha256:"a".repeat(64),outputSha256:"b".repeat(64),attempt:1,occurredAt:90},
  {id:2,projectId:"p",runId:"r1",taskId:"t1",gate:"verification",status:"failed",inputSha256:"a".repeat(64),outputSha256:"c".repeat(64),attempt:1,occurredAt:95},
  {id:3,projectId:"other",runId:"r2",taskId:"t2",gate:"verification",status:"passed",inputSha256:"a".repeat(64),outputSha256:null,attempt:1,occurredAt:96},
];

describe("read-only stage gate report",()=>{
  it("filters to one project and bounded period, aggregating terminal blockers without raw result data",()=>{
    const report=buildGateReport({projectId:"p",days:1,now:100},events);
    expect(report).toMatchObject({schemaVersion:1,projectId:"p",totalEvents:3,byStage:[
      {stageId:"plan-critique",total:1,byState:{passed:1}},
      {stageId:"writer-agent",total:2,byState:{blocked:1,failed:1}},
    ]});
    expect(report.recentBlockers.map((row)=>row.runId)).toEqual(["r2","r1"]);
  });

  it("supports exact stage selection and rejects unbounded or invalid filters",()=>{
    expect(buildGateReport({projectId:"p",days:1,stageId:"writer-agent",now:100},events).totalEvents).toBe(2);
    expect(()=>buildGateReport({projectId:"p",days:0,now:100},events)).toThrow();
    expect(()=>buildGateReport({projectId:"p",days:1,stageId:"unknown",now:100} as never,events)).toThrow();
  });

  it("filters append-only gate evaluations by exact upstream category and project",()=>{
    const report=buildGateReport({projectId:"p",days:1,gate:"verification",now:100},events,gateEvents);
    expect(report).toMatchObject({totalEvents:3,totalGateEvents:1,byGate:[{
      gate:"verification",total:1,byStatus:{failed:1},
    }],recentGateBlockers:[{runId:"r1",taskId:"t1",gate:"verification",status:"failed",attempt:1,occurredAt:95}]});
    expect(()=>buildGateReport({projectId:"p",days:1,gate:"unknown",now:100} as never,events,gateEvents)).toThrow();
  });
});
