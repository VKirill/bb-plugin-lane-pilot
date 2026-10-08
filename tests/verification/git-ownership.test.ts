import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitOwnershipChangedPaths, resolveGitOwnershipBase } from "../../src/rooms/verification/git-ownership";

let root:string|undefined;
afterEach(async()=>{if(root) await rm(root,{recursive:true,force:true});root=undefined;});

function git(cwd:string,...args:string[]) { execFileSync("git",args,{cwd,stdio:"ignore"}); }

describe("git ownership base adapter",()=>{
  it("unfiltered keeps .agents and memory files that the writer check treats as noise",async()=>{
    root=await mkdtemp(join(tmpdir(),"lp-own-raw-"));
    git(root,"init","-b","main");
    git(root,"config","user.email","lane-pilot@example.invalid");
    git(root,"config","user.name","Lane Pilot test");
    await writeFile(join(root,"README.md"),"base\n");git(root,"add",".");git(root,"commit","-m","base");
    const base=execFileSync("git",["rev-parse","HEAD"],{cwd:root}).toString().trim();
    await mkdir(join(root,".agents"),{recursive:true});
    await writeFile(join(root,".agents","PROGRESS.md"),"now\n");await writeFile(join(root,".agents","LESSONS.md"),"x\n");
    git(root,"add",".");git(root,"commit","-m","memory");
    expect((await gitOwnershipChangedPaths({projectCwd:root,baseSha:base,compareCommitted:true})).paths).toEqual([]);
    expect((await gitOwnershipChangedPaths({projectCwd:root,baseSha:base,compareCommitted:true,unfiltered:true})).paths)
      .toEqual([".agents/LESSONS.md",".agents/PROGRESS.md"]);
  });
  it("captures upstream-style main defaults and checks feature changes from a frozen merge base",async()=>{
    root=await mkdtemp(join(tmpdir(),"lane-pilot-git-base-"));
    git(root,"init","-b","main");
    git(root,"config","user.email","lane-pilot@example.invalid");
    git(root,"config","user.name","Lane Pilot test");
    await mkdir(join(root,"src"));
    await writeFile(join(root,"README.md"),"base\n");
    git(root,"add",".");git(root,"commit","-m","base");
    const main=await resolveGitOwnershipBase({projectCwd:root});
    expect(main).toMatchObject({status:"ready",branch:"main",compareCommitted:false,baseSha:null});
    git(root,"switch","-c","feature");
    const frozen=await resolveGitOwnershipBase({projectCwd:root});
    expect(frozen).toMatchObject({status:"ready",branch:"feature",compareCommitted:true,baseRef:"main"});
    await writeFile(join(root,"src","owned file.ts"),"export {};\n");
    git(root,"add",".");git(root,"commit","-m","feature work");
    const changed=await gitOwnershipChangedPaths({projectCwd:root,baseSha:frozen.baseSha,compareCommitted:frozen.compareCommitted});
    expect(changed.status).toBe("ready");
    expect(changed.paths).toEqual(["src/owned file.ts"]);
  });

  it("honors explicit base on main and rejects invalid or shell-shaped refs without execution",async()=>{
    root=await mkdtemp(join(tmpdir(),"lane-pilot-git-base-"));
    git(root,"init","-b","main");
    git(root,"config","user.email","lane-pilot@example.invalid");
    git(root,"config","user.name","Lane Pilot test");
    await writeFile(join(root,"README.md"),"base\n");git(root,"add",".");git(root,"commit","-m","base");
    const base=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
    await writeFile(join(root,"changed.md"),"changed\n");git(root,"add",".");git(root,"commit","-m","change");
    const explicit=await resolveGitOwnershipBase({projectCwd:root,baseRef:base});
    expect(explicit).toMatchObject({status:"ready",branch:"main",compareCommitted:true,baseSha:base});
    const changed=await gitOwnershipChangedPaths({projectCwd:root,baseSha:explicit.baseSha,compareCommitted:true});
    expect(changed.paths).toEqual(["changed.md"]);
    const marker=join(root,"should-not-exist");
    const invalid=await resolveGitOwnershipBase({projectCwd:root,baseRef:`main;touch ${marker}`});
    expect(invalid.status).toBe("invalid-ref");
    await expect(readFile(marker)).rejects.toMatchObject({code:"ENOENT"});
  });
});

it("treats tool caches inside monorepo packages as bookkeeping, not as the writer's change", async () => {
  const { filterOwnershipNoise } = await import("../../src/rooms/verification/git-ownership");
  expect(filterOwnershipNoise([
    "packages/contracts/.vite/vitest/da39a3ee/results.json",
    "apps/web/node_modules/.cache/x",
    "apps/api/.turbo/turbo-build.log",
    "packages/contracts/src/vite.config.ts",
    "apps/web/.vitepress/config.ts",
  ])).toEqual(["apps/web/.vitepress/config.ts", "packages/contracts/src/vite.config.ts"]);
});
