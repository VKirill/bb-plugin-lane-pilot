import { describe,expect,it } from "vitest";
import { acceptedOnboardingEvidence,onboardingPrompt,parseOnboardingPreview } from "../../src/stages/onboarding";

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
  it("prefers accepted receipt evidence over stale observed pages and stays preview-only",()=>{
    const stale="This page is stale. After the writer creates f4-onboard-live.txt, file creation and verification remain unconfirmed.";
    const accepted=acceptedOnboardingEvidence({
      outputSha256:"c".repeat(64),
      result:{
        status:"accepted",
        output:"Changed only f4-onboard-live.txt. Verification grep -qx passed.",
        ownsPaths:["f4-onboard-live.txt"],
        produced:["f4-onboard-live.txt"],
        verification:[{command:"grep -qx f4-onboard-live-20260924 f4-onboard-live.txt",exitCode:0}],
      },
    });
    const prompt=onboardingPrompt({
      task:{expected_outputs:["f4-onboard-live.txt"]},
      pages:[{path:"docs/f4-onboard-live.md",sha256:hash,content:stale}],
      accepted,
      depth:"fast",
    });
    expect(prompt).toContain("ACCEPTED WRITER RECEIPT");
    expect(prompt).toContain('"status":"accepted"');
    expect(prompt).toContain("f4-onboard-live.txt");
    expect(prompt).toContain('"exitCode":0');
    expect(prompt).toContain(stale);
    expect(prompt).toContain("prefer the receipt");
    expect(prompt).toContain("Facts not listed in the receipt stay questions");
    expect(prompt).toContain("Preview only");
    expect(prompt).toContain("separate explicit confirmation");
    expect(prompt).not.toContain("auto apply");
  });
  it("rejects duplicate edits",()=>{
    const edit={path:"docs/guide.md",expectedSha256:hash,content:"x"};
    expect(()=>parseOnboardingPreview(JSON.stringify({summary:"Preview",edits:[edit,edit]}),[{path:edit.path,sha256:hash,content:"old"}])).toThrow("duplicate");
  });
});
