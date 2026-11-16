import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../../src/rooms/contracts";
import { normalizeRepoReads, rerootTask, rerootToRepoRoot } from "../../src/rooms/tasks/task-base";
import { repoReadRoot } from "../../src/rooms/tasks/repo-read";
import { lintContract, lintProbePaths } from "../../src/rooms/tasks/server/contract-lint";

const task = ():TaskV2 => ({schema_version:2,id:"section-read",title:"Read SDK",display_title:"Чтение SDK",kind:"fix",area:"bot",risk:"low",lane:"writer",
  project_cwd:"/repo/bot",read_first:["../sdk/index.ts:1-20","src/main.ts"],owns_paths:["src/**"],never_touch:["../sdk/**","dist/**"],expected_outputs:["src/main.ts"],
  objective:"Use shared SDK",acceptance:["Uses SDK"],verify:"tests",verification:[{command:"node --test test.js",cwd:"/repo/bot",timeout_sec:30}],
  interfaces:[],invariants:[],out_of_scope:[],depends_on:[]});
const lint = (t:TaskV2, repoRootPath?:string|null) => lintContract({task:t,workspacePath:t.project_cwd,repoRootPath,hostId:"remote",kinds:new Map([["/repo/sdk/index.ts","file"],["/repo/bot/src/main.ts","file"]]),sandboxUnsafe:[],openTasks:[],deadDependencies:[]}).errors.filter((e)=>e.code.startsWith("read_first"));

describe("section read placement",()=>{
  it("normalizes only same-repo reads while preserving section cwd and write ownership",()=>{
    const original=task(), normalized=normalizeRepoReads(original,"bot");
    expect(normalized.read_first).toEqual(["repo:sdk/index.ts:1-20","src/main.ts"]);
    expect(normalized.project_cwd).toBe("/repo/bot");
    expect(normalized.repo_scope).toBeUndefined();
    expect(normalized.owns_paths).toEqual(["src/**"]);
    expect(normalized.never_touch).toEqual(["dist/**"]);
    expect(original.read_first[0]).toBe("../sdk/index.ts:1-20");
    expect(lint(normalized,"/repo")).toEqual([]);
    expect(lintProbePaths(normalized,"/repo/bot","/repo")).toContain("/repo/sdk/index.ts");
    expect(lint(normalized)).toEqual([expect.objectContaining({code:"read_first_repo_unknown"})]);
  });
  it("keeps traversal out of the repository invalid and rejects protected sibling content",()=>{
    for(const raw of ["../../outside.ts","../.git/config","../nested/.agents/plans/foreign.md"]){
      const normalized=normalizeRepoReads({...task(),read_first:[raw]},"bot");
      expect(lint(normalized,"/repo")).toContainEqual(expect.objectContaining({code:"read_first_path"}));
    }
  });
  it("preserves order/windows when moving to the same root, refuses rebinding into another repository",()=>{
    const source={...task(),read_first:["repo:sdk/index.ts:1-20","src/main.ts"],never_touch:[]};
    expect(rerootToRepoRoot(source,"/repo","bot")?.task.read_first).toEqual(["sdk/index.ts:1-20","bot/src/main.ts"]);
    expect(rerootToRepoRoot({...source,read_first:["repo:.git/config"]},"/repo","bot")).toBeNull();
    expect(rerootTask({...source,project_cwd:"/umbrella",owns_paths:["bot/src/**"],expected_outputs:["bot/src/main.ts"],verification:[]},"bot")).toBeNull();
  });
  it("discovers root on the requested host and keeps its real path rather than resolving a local alias",async()=>{
    const calls:unknown[]=[];
    const host={call:async(...args:unknown[])=>{calls.push(args);return {hostId:"remote",exitCode:0,stdout:"/remote/repo\n/remote/repo/bot\n",stderr:""};}};
    expect(await repoReadRoot(host,"remote","/alias",["repo:sdk/index.ts"])).toEqual({root:"/remote/repo",prefix:"bot"});
    expect(calls).toEqual([["runCommand",expect.objectContaining({requestedHostId:"remote",cwd:"/alias"}),expect.objectContaining({hostId:"remote"})]]);
    expect(await repoReadRoot(host,"remote","/alias",["src/main.ts"])).toBeNull();
    expect(calls).toHaveLength(1);
  });
  it.each(["repo:2026-10-report.md", "./repo:sdk/index.ts"])("preserves selector before line parsing: %s",async(raw)=>{
    const host={call:async()=>({hostId:"remote",exitCode:0,stdout:"/repo\n/repo/bot\n",stderr:""})};
    expect(await repoReadRoot(host,"remote","/repo/bot",[raw])).toEqual({root:"/repo",prefix:"bot"});
    const source={...task(),read_first:[raw],never_touch:[]};
    expect(rerootToRepoRoot(source,"/repo","bot")?.task.read_first).toEqual([raw.replace(/^\.\//,"").slice(5)]);
  });
  it.each(["/elsewhere\n/remote/repo/bot\n","/remote/repo\n/remote/repo\n","/remote/repo\n/remote/repo/bot\nextra\n"])("refuses unverified root answer %s",async(stdout)=>{
    const host={call:async()=>({hostId:"remote",exitCode:0,stdout,stderr:""})};
    expect(await repoReadRoot(host,"remote","/alias",["repo:sdk/index.ts"])).toBeNull();
  });
});
