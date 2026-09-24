import { describe,expect,it } from "vitest";
import { buildNightFixPlan,decideNightMerge } from "../../src/stages/night-fix";

const task={project_cwd:"/repo",owns_paths:["src/**"],never_touch:["src/vendor/**"],verification:[]};
const review={decision:"findings" as const,summary:"needs repair",findings:[{severity:"blocking" as const,path:"src/main.ts",finding:"broken interface",suggestedFix:"restore export"}]};

describe("night bounded fix policy",()=>{
  it("accepts only owned safe relative paths",()=>expect(buildNightFixPlan(review,task).paths).toEqual(["src/main.ts"]));
  it("caps actionable findings from the native max_fix_tasks setting",()=>{
    const findings=Array.from({length:8},(_,index)=>({...review.findings[0]!,path:`src/file-${index}.ts`}));
    expect(buildNightFixPlan({...review,findings},task,3).findings).toHaveLength(3);
    expect(buildNightFixPlan({...review,findings},task,99).findings).toHaveLength(8);
  });
  it.each(["../secret","/etc/passwd","C:\\Users\\file","src/vendor/foreign.ts"])("rejects unsafe or unowned finding path %s",(path)=>{
    expect(()=>buildNightFixPlan({...review,findings:[{...review.findings[0]!,path}]},task)).toThrow();
  });
  it("denies merge by default and until every verification/PR gate is satisfied",()=>{
    const ready={explicitlyEnabled:true,fixState:"passed",verificationPassed:true,managedWorktree:true,pullRequestOutcome:"available" as const,
      pullRequestState:"open",attention:"ready_to_merge",checksState:"passing",reviewState:"approved",mergeability:"mergeable"};
    expect(decideNightMerge({...ready,explicitlyEnabled:false}).reason).toBe("merge_not_explicitly_authorized");
    expect(decideNightMerge({...ready,checksState:"pending"}).merge).toBe(false);
    expect(decideNightMerge(ready)).toMatchObject({merge:true});
  });
});
