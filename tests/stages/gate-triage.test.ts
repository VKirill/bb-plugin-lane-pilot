import { describe,expect,it } from "vitest";
import { gateTriagePrompt,parseGateTriageResult } from "../../src/stages/gate-triage";
import type { GateReport } from "../../src/stages/gate-report";

const report:GateReport={schemaVersion:1,projectId:"project-a",from:10,to:20,totalEvents:2,totalGateEvents:1,
  byStage:[{stageId:"verification",total:2,byState:{failed:1,passed:1}}],
  byGate:[{gate:"verification",total:1,byStatus:{failed:1}}],
  recentBlockers:[{runId:"run-a",taskId:"task-a",stageId:"verification",state:"failed",attempt:1,occurredAt:15}],
  recentGateBlockers:[{runId:"run-a",taskId:"task-a",gate:"verification",status:"failed",attempt:1,occurredAt:15}]};

describe("read-only gate triage stage",()=>{
  it("prompts the model with bounded aggregate evidence and no task content or repair powers",()=>{
    const prompt=gateTriagePrompt(report);
    expect(prompt).toContain('"totalEvents":2');
    expect(prompt).toContain("Do not edit, execute, repair, merge");
    expect(prompt).not.toContain("sourceText");
  });

  it("parses clear and bounded recommendations while rejecting malformed responses",()=>{
    expect(parseGateTriageResult(JSON.stringify({decision:"clear",summary:"No failed gates in range",recommendations:[]})).decision).toBe("clear");
    expect(parseGateTriageResult(JSON.stringify({decision:"recommendations",summary:"One repeated verification failure",recommendations:[{stageId:"verification",state:"failed",count:1,action:"Inspect the linked run receipt."}]})).recommendations).toHaveLength(1);
    expect(()=>parseGateTriageResult(JSON.stringify({decision:"clear",summary:"bad",recommendations:[{stageId:"verification",state:"failed",count:1,action:"bad"}]}))).toThrow();
    expect(()=>parseGateTriageResult(JSON.stringify({decision:"recommendations",summary:"bad",recommendations:[{stageId:"unknown",state:"failed",count:1,action:"bad"}]}))).toThrow();
  });
});
