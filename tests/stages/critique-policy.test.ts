import { describe, expect, it } from "vitest";
import { critiquePrompt, shouldRunPlanCritique } from "../../src/stages/critique";
import { validateSettingValue } from "../../src/setting-validation";

describe("plan critique policy", () => {
  it("includes deterministic ownership findings in the actual model critique prompt", () => {
    const findings=[{code:"plan_path_unowned" as const,path:"src/missing.ts",severity:"warning" as const,finding:"Unowned"}];
    expect(critiquePrompt({plan:"Edit `src/missing.ts`",task:{id:"t"},structuralFindings:findings}))
      .toContain('"code":"plan_path_unowned","path":"src/missing.ts"');
  });

  it("uses upstream score, write-task and high-risk thresholds", () => {
    expect(shouldRunPlanCritique({taskRisk:"low",tasks:[{lane:"writer"}]})).toMatchObject({
      run:false,score:2,writeTaskCount:1,reason:"score 2<7 and 1 write tasks<3",
    });
    expect(shouldRunPlanCritique({taskRisk:"high",tasks:[{lane:"writer"}],minWriteTasks:3})).toMatchObject({run:true,reason:"score 8>=7"});
    expect(shouldRunPlanCritique({taskRisk:"low",tasks:[{lane:"writer"},{lane:"write"},{lane:"specialist"}]})).toMatchObject({run:true,reason:"3 write tasks>=3"});
    expect(shouldRunPlanCritique({taskRisk:"high",tasks:[{lane:"writer"},{lane:"review"},{lane:"verify"}],minScore:11,minWriteTasks:3})).toMatchObject({run:true,reason:"risk=high",writeTaskCount:1});
    expect(shouldRunPlanCritique({taskRisk:"critical",tasks:[{lane:"writer"}],minScore:11,minWriteTasks:3,onHighRisk:false})).toMatchObject({run:false,score:10,writeTaskCount:1});
  });

  it("rejects invalid bounded setting values and accepts numeric strings from the UI", () => {
    expect(validateSettingValue("plan_critique.min_score","11")).toBeNull();
    expect(validateSettingValue("plan_critique.min_score",-1)?.code).toBe("invalid_choice");
    expect(validateSettingValue("plan_critique.min_write_tasks","0")?.code).toBe("invalid_choice");
    expect(validateSettingValue("plan_critique.min_write_tasks","3.5")?.code).toBe("invalid_choice");
  });

  it("fails closed when persisted policy settings are malformed", () => {
    expect(() => shouldRunPlanCritique({taskRisk:"medium",tasks:[{lane:"writer"}],minScore:"seven"})).toThrow("plan_critique.min_score must be an integer >= 0");
    expect(() => shouldRunPlanCritique({taskRisk:"low",tasks:[{lane:"writer"}],onHighRisk:"sometimes"})).toThrow("plan_critique.on_high_risk must be a boolean");
  });
});
