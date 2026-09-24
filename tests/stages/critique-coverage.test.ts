import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGitNexusCallerPaths, findTaskPlaceholderPaths, scanCritiqueCoverage } from "../../src/stages/critique-coverage";

const roots:string[]=[];
async function workspace():Promise<string>{const path=await mkdtemp(join(tmpdir(),"lane-pilot-critique-"));roots.push(path);return path;}
afterEach(async()=>{await Promise.all(roots.splice(0).map((path)=>rm(path,{recursive:true,force:true})));});

describe("bounded structural critique coverage scan",()=>{
  it("checks existing plan paths, sibling tests and source references without following symlinks",async()=>{
    const root=await workspace();
    await mkdir(join(root,"src"),{recursive:true});await mkdir(join(root,"tests"),{recursive:true});await mkdir(join(root,"docs"),{recursive:true});
    await writeFile(join(root,"src/core.ts"),"export function coreFeature() { return true; }\n");
    await writeFile(join(root,"src/core.test.ts"),"import { coreFeature } from './core';\n");
    await writeFile(join(root,"tests/consumer.test.ts"),"// exercises coreFeature\n");
    await writeFile(join(root,"src/missing.ts"),"export const missing = true;\n");
    await writeFile(join(root,"docs/guide.md"),"Guide\n");
    const outside=await mkdtemp(join(tmpdir(),"lane-pilot-outside-"));roots.push(outside);
    await writeFile(join(outside,"secret.ts"),"coreFeature\n");
    await symlink(outside,join(root,"external"));

    const result=await scanCritiqueCoverage({workspacePath:root,plan:"Edit `src/core.ts`, `src/missing.ts`, `docs/guide.md`, and `src/not-created.ts`",tasks:[{id:"core",lane:"writer",owns_paths:["src/core.ts"],has_verification:true}]});
    expect(result.status).toBe("truncated");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"plan_path_unowned",path:"src/missing.ts",severity:"warning"}),
      expect.objectContaining({code:"plan_path_unowned",path:"docs/guide.md",severity:"info"}),
      expect.objectContaining({code:"owns_gap",path:"src/core.test.ts",severity:"warning"}),
      expect.objectContaining({code:"owns_gap",path:"tests/consumer.test.ts",severity:"warning"}),
      expect.objectContaining({code:"coverage_scan_truncated",path:".gitnexus",severity:"warning"}),
    ]));
    expect(result.findings.some((finding)=>finding.path.includes("not-created")||finding.path.includes("secret"))).toBe(false);
  });

  it("includes safe bounded SPEC.md path mentions in ownership coverage",async()=>{
    const root=await workspace();
    await mkdir(join(root,"src"),{recursive:true});
    await writeFile(join(root,"src/owned.ts"),"export const owned = true;\n");
    await writeFile(join(root,"src/spec-reference.ts"),"export const referenced = true;\n");
    await writeFile(join(root,"SPEC.md"),"The adapter lives in `src/spec-reference.ts`.\n");
    const result=await scanCritiqueCoverage({workspacePath:root,plan:"Valid plan",tasks:[{id:"spec",lane:"writer",owns_paths:["src/owned.ts"],has_verification:true}]});
    expect(result.findings).toContainEqual(expect.objectContaining({code:"plan_path_unowned",path:"src/spec-reference.ts",severity:"warning",finding:expect.stringContaining("SPEC.md")}));
  });

  it("fails closed for a symlink workspace root",async()=>{
    const root=await workspace(),link=`${root}-link`;roots.push(link);
    await symlink(root,link);
    await expect(scanCritiqueCoverage({workspacePath:link,plan:"",tasks:[]})).rejects.toThrow("real directory");
  });

  it("blocks overlapping writer ownership and missing write verification",async()=>{
    const root=await workspace();
    const result=await scanCritiqueCoverage({workspacePath:root,plan:"",tasks:[
      {id:"a",lane:"writer",owns_paths:["src/**"],has_verification:true},
      {id:"b",lane:"writer",owns_paths:["src/core.ts"],has_verification:false},
    ]});
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"owns_overlap",severity:"error"}),
      expect.objectContaining({code:"verify_missing",severity:"error",path:"tasks/b"}),
    ]));
  });

  it("flags missing structural inputs and broad verification commands on multi-task plans",async()=>{
    const root=await workspace();
    const result=await scanCritiqueCoverage({workspacePath:root,plan:"",tasks:[
      {id:"a",lane:"writer",owns_paths:[],has_verification:true,verification:[{command:"npm test"}]},
      {id:"b",lane:"verify",owns_paths:[],has_verification:false,verification:[]},
    ]});
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({code:"plan_missing",severity:"error"}),
      expect.objectContaining({code:"owns_empty",severity:"error",path:"tasks/a"}),
      expect.objectContaining({code:"verify_heavy",severity:"warning",path:"tasks/a"}),
    ]));
    expect(result.findings.some((finding)=>finding.code==="verify_missing"&&finding.path==="tasks/b")).toBe(false);
  });

  it("does not flag the TaskV2 verify:none mode or path-scoped focused suites",async()=>{
    const root=await workspace();
    const result=await scanCritiqueCoverage({workspacePath:root,plan:"Valid non-empty plan",tasks:[
      {id:"none",lane:"writer",owns_paths:["src/one.ts"],has_verification:true,verification:[]},
      {id:"focused",lane:"writer",owns_paths:["src/two.ts"],has_verification:true,verification:[{command:"npm test -- tests/two.test.ts"}]},
    ]});
    expect(result.findings.some((finding)=>finding.code==="verify_missing"||finding.code==="verify_heavy")).toBe(false);
  });

  it("reports partial coverage when the bounded owned-path scan cannot inspect every path",async()=>{
    const root=await workspace();
    const result=await scanCritiqueCoverage({workspacePath:root,plan:"A sufficiently explicit plan",tasks:[{
      id:"many-paths",lane:"writer",has_verification:true,
      owns_paths:Array.from({length:10},(_,index)=>`src/file-${index}.ts`),
    }]});
    expect(result.status).toBe("truncated");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code:"coverage_scan_truncated",path:"owns_paths",severity:"warning",finding:expect.stringContaining("2 additional paths"),
    }));
  });

  it("keeps the finding cap explicit instead of returning complete with dropped gaps",async()=>{
    const root=await workspace();
    await mkdir(join(root,"src"),{recursive:true});
    const paths=Array.from({length:15},(_,index)=>`src/unowned-${index}.ts`);
    await Promise.all(paths.map((path)=>writeFile(join(root,path),"export const present = true;\n")));
    const result=await scanCritiqueCoverage({workspacePath:root,plan:paths.map((path)=>`See \`${path}\``).join(" "),tasks:[]});
    expect(result.status).toBe("truncated");
    expect(result.findings).toContainEqual(expect.objectContaining({code:"coverage_scan_truncated",path:"findings",severity:"warning"}));
  });

  it("locates unresolved placeholders in bounded TaskV2 inputs",()=>{
    expect(findTaskPlaceholderPaths({title:"REPLACE_ME title",acceptance:["done"],metadata:{note:"REPLACE_ME hidden"}})).toEqual(["title","metadata.note"]);
  });

  it("finds bounded direct callers of owned exported functions outside TaskV2 ownership",async()=>{
    const root=await workspace();
    await mkdir(join(root,"src"),{recursive:true});
    await writeFile(join(root,"src/core.ts"),"export function runCore() { return 1; }\nexport const runArrow = () => true;\n");
    await writeFile(join(root,"src/consumer.ts"),"import { runCore, runArrow } from './core';\nexport const value = runCore() && runArrow();\n");
    const result=await scanCritiqueCoverage({workspacePath:root,plan:"",tasks:[{id:"core",lane:"writer",owns_paths:["src/core.ts"],has_verification:true}]});
    expect(result.findings).toContainEqual(expect.objectContaining({code:"caller_unowned",path:"src/consumer.ts",severity:"warning"}));
  });

  it("collects indexed GitNexus filePath results and rejects paths outside the workspace",()=>{
    expect(collectGitNexusCallerPaths({byDepth:{"1":[
      {filePath:"src/consumer.ts"},{filePath:"/workspace/tests/consumer.test.ts"},{filePath:"../../outside.ts"},
    ]}},"/workspace")).toEqual(["src/consumer.ts","tests/consumer.test.ts"]);
  });
});
