import { describe, expect, it } from "vitest";
import { parseSpecialistResult, shouldRunSpecialist, specialistPrompt } from "../../src/stages/specialist";

describe("specialist review stage contract", () => {
  it("runs for high or critical risk and supports an explicit always policy", () => {
    expect(shouldRunSpecialist({enabled:true,when:"high_risk",risk:"high"})).toEqual({run:true,reason:null});
    expect(shouldRunSpecialist({enabled:true,when:"high_risk",risk:"critical"})).toEqual({run:true,reason:null});
    expect(shouldRunSpecialist({enabled:true,when:"always",risk:"low"})).toEqual({run:true,reason:null});
    expect(shouldRunSpecialist({enabled:true,when:"high_risk",risk:"medium"})).toEqual({run:false,reason:"risk_below_specialist_threshold"});
  });

  it("skips disabled policy and fails closed on invalid policy values", () => {
    expect(shouldRunSpecialist({enabled:false,when:"always",risk:"critical"}).reason).toBe("disabled_by_project_setting");
    expect(shouldRunSpecialist({enabled:"sometimes",when:"always",risk:"critical"}).reason).toBe("invalid_specialist_enabled_setting");
    expect(shouldRunSpecialist({enabled:true,when:"on_change",risk:"critical"}).reason).toBe("unsupported_specialist_when:on_change");
  });

  it("accepts only bounded typed findings and rejects malformed model output", () => {
    const output = JSON.stringify({decision:"block",summary:"Unmitigated destructive rollout",risks:[{
      severity:"critical",path:"src/stack-ops.ts",concern:"Writes user settings before snapshot",mitigation:"Isolate the install HOME first",
    }]});
    expect(parseSpecialistResult(output).risks).toHaveLength(1);
    expect(() => parseSpecialistResult('{"decision":"block","summary":"x","risks":[{"severity":"info"}]}')).toThrow();
  });

  it("embeds the exact task and plan in a non-executing review prompt", () => {
    const prompt = specialistPrompt({task:{risk:"critical",id:"T-1"},plan:"Keep rollback snapshot",agent:"compatibility-reviewer"});
    expect(prompt).toContain("You are compatibility-reviewer");
    expect(prompt).toContain('"risk":"critical"');
    expect(prompt).toContain("Keep rollback snapshot");
    expect(prompt).toContain("Do not execute tools or modify files");
  });
});
