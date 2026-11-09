import { describe, expect, it } from "vitest";
import { parsePmReadResult, parsePmReadSettings, pmReadPrompt } from "../../src/rooms/critique/pm-read";

describe("PM read stage",()=>{
  it("parses bounded controls and defaults to disabled",()=>{
    expect(parsePmReadSettings({})).toEqual({enabled:false,minLines:350,provider:null,model:null,effort:"low",serviceTier:"standard"});
    expect(parsePmReadSettings({"pm_read.enabled":"on","pm_read.min_lines":"500","pm_read.provider":"codex","pm_read.model":"gpt-6-luna","pm_read.reasoning_effort":"high","pm_read.service_tier":"fast"}))
      .toEqual({enabled:true,minLines:500,provider:"codex",model:"gpt-6-luna",effort:"high",serviceTier:"fast"});
    expect(()=>parsePmReadSettings({"pm_read.min_lines":49})).toThrow("pm_read.min_lines");
    expect(()=>parsePmReadSettings({"pm_read.service_tier":"turbo"})).toThrow("pm_read.service_tier");
  });

  // Live 2026-10-15 (fix-marketing-webapp-lint, helper thr_iuc9kckvwi on claude-haiku-5-5): a complete answer with one
  // extra top-level key blocked the attempt as pm_read_failed:unrecognized_keys.
  it("drops a stray top-level key instead of failing the read",()=>{
    const live=JSON.stringify({
      summary:"The excerpts cover three files under apps/marketing/app/pages/webapp/, the scope of the lint-fix task.",
      keyFacts:["apps/marketing/app/pages/webapp/catalog/index.vue: the script is definePageMeta({ ssr: false })."],
      openQuestions:["trends/index.vue, which the test imports, is not in the excerpts, so its state and its lint status are unknown."],
      __note:"Excerpts only; no files were opened or changed in producing this summary.",
    });
    const parsed=parsePmReadResult(live);
    expect(Object.keys(parsed)).toEqual(["summary","keyFacts","openQuestions"]);
    expect(parsed.keyFacts).toHaveLength(1);
  });

  it("requires a bounded structured result",()=>{
    expect(parsePmReadResult('{"summary":"Context","keyFacts":["Fact"],"openQuestions":[]}')).toMatchObject({summary:"Context",keyFacts:["Fact"]});
    expect(()=>parsePmReadResult('{"summary":"Context","keyFacts":[],"openQuestions":"none"}')).toThrow();
    expect(()=>parsePmReadResult('{"summary":"Context","keyFacts":[]}')).toThrow();
  });

  // Owner, 2026-11-10: a pm-read thread got 28,041 characters, 24 KB of them pasted source (5 of the task's 16 read_first files, the
  // fifth cut mid-line), under «open no files, run no commands and call no tools» in a thread with the whole checkout.
  it("is a scout's brief: where to start and what to report, the files are read by the agent",()=>{
    const readFirst=Array.from({length:16},(_,i)=>`app/src/file-${i}.ts`);
    const prompt=pmReadPrompt({task:{title:"Card only",objective:"Buy screen offers card only",read_first:readFirst,acceptance:["menu:buy shows pay:card"],owns_paths:["app/src/**"]},plan:"1. Add RESTORE_PACKAGES to app/src/packages.ts"});
    for(const path of readFirst) expect(prompt).toContain(`- ${path}`);
    expect(prompt).toContain("You are running in the project checkout. Open the read_first files");
    expect(prompt).toContain("Read only: create, edit or delete nothing");
    expect(prompt).toContain("<plan>\n1. Add RESTORE_PACKAGES to app/src/packages.ts\n</plan>");
    expect(prompt).not.toContain("open no files");
    expect(prompt).not.toContain("```");
    expect(prompt.length).toBeLessThan(5_000);
    expect(pmReadPrompt({task:{objective:"Review docs"}})).not.toContain("<plan>");
  });
});
