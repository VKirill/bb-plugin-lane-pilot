import { describe,expect,it } from "vitest";
import { onboardingPrompt,parseOnboardingPreview } from "../../src/stages/onboarding";

const hash="a".repeat(64);

describe("bounded onboarding preview",()=>{
  it("builds a read-only preview prompt that requires explicit acceptance before writes",()=>{
    const prompt=onboardingPrompt({task:{title:"onboard"},pages:[],depth:"fast"});
    expect(prompt).toContain("Do not use tools, write files");
    expect(prompt).toContain("separate explicit confirmation");
    expect(prompt).toContain("expectedSha256:null");
  });
  it("accepts a hash-bound existing page and a new project page",()=>{
    const pages=[{path:"docs/guide.md",sha256:hash,content:"old"}];
    const result=parseOnboardingPreview(JSON.stringify({summary:"A bounded project map",edits:[
      {path:"docs/guide.md",expectedSha256:hash,content:"# Updated"},
      {path:"apps/overview.md",expectedSha256:null,content:"# Apps"},
    ]}),pages);
    expect(result.edits).toHaveLength(2);
  });
  it.each([
    [{path:"../CLAUDE.md",expectedSha256:null,content:"x"}],
    [{path:".agents/LESSONS.md",expectedSha256:null,content:"x"}],
    [{path:"docs/guide.md",expectedSha256:"b".repeat(64),content:"x"}],
  ])("rejects unsafe paths and stale hashes",(edits)=>{
    expect(()=>parseOnboardingPreview(JSON.stringify({summary:"Preview",edits}),[{path:"docs/guide.md",sha256:hash,content:"old"}])).toThrow();
  });
  it("rejects duplicate edits",()=>{
    const edit={path:"docs/guide.md",expectedSha256:hash,content:"x"};
    expect(()=>parseOnboardingPreview(JSON.stringify({summary:"Preview",edits:[edit,edit]}),[{path:edit.path,sha256:hash,content:"old"}])).toThrow("duplicate");
  });
});
