import { describe, expect, it } from "vitest";
import { nightReviewResultSchema, parseNightReviewResult, shouldRunNightReview } from "../../src/stages/night";

describe("night review stage",()=>{
  it("is opt-in and rejects malformed policy values",()=>{
    expect(shouldRunNightReview(undefined)).toEqual({run:false,reason:"disabled_by_project_setting"});
    expect(shouldRunNightReview("on")).toEqual({run:true,reason:null});
    expect(shouldRunNightReview("sometimes").reason).toBe("invalid_night_review_enabled_setting");
  });
  it("parses bounded findings and rejects contradictory or oversized results",()=>{
    const raw=JSON.stringify({decision:"findings",summary:"One bounded correction is needed",findings:[{severity:"warning",path:"src/example.ts",finding:"Missing edge case",suggestedFix:"Handle the empty input"}]});
    expect(parseNightReviewResult(raw).findings).toHaveLength(1);
    expect(()=>nightReviewResultSchema.parse({decision:"clear",summary:"Clear",findings:[{severity:"warning",path:"x",finding:"y",suggestedFix:"z"}]})).toThrow();
    expect(()=>parseNightReviewResult("not json")).toThrow();
    expect(()=>nightReviewResultSchema.parse({decision:"findings",summary:"Too many",findings:Array.from({length:21},()=>({severity:"warning",path:"x",finding:"y",suggestedFix:"z"}))})).toThrow();
  });
});
