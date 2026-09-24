import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOnboardingPages } from "../../src/host-handlers";

const hash=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
const call=(input:Parameters<typeof applyOnboardingPages>[0])=>applyOnboardingPages(input,undefined as never);

describe("host-bound onboarding CAS apply",()=>{
  it("creates only a confirmed Markdown page and returns before/after hashes",async()=>{
    const root=await mkdtemp(join(tmpdir(),"lane-onboarding-"));
    try{
      await mkdir(join(root,"docs"));
      const edits=[{path:"docs/guide.md",expectedSha256:null,content:"# Guide\n"}],previewSha256=hash(JSON.stringify(edits));
      const receipt=await call({requestedHostId:"host-test",projectCwd:root,confirmed:true,previewSha256,edits});
      expect(receipt).toMatchObject({status:"applied",hostId:"host-test",previewSha256,writes:[{path:"docs/guide.md",beforeSha256:null,afterSha256:hash("# Guide\n"),status:"applied"}]});
      expect(await readFile(join(root,"docs/guide.md"),"utf8")).toBe("# Guide\n");
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it("fails stale CAS without changing any file",async()=>{
    const root=await mkdtemp(join(tmpdir(),"lane-onboarding-"));
    try{
      await mkdir(join(root,"docs"));await writeFile(join(root,"docs/guide.md"),"user edit\n");
      const edits=[{path:"docs/guide.md",expectedSha256:hash("old\n"),content:"# Proposed\n"}],previewSha256=hash(JSON.stringify(edits));
      const receipt=await call({requestedHostId:"host-test",projectCwd:root,confirmed:true,previewSha256,edits});
      expect(receipt.status).toBe("conflict");
      expect(await readFile(join(root,"docs/guide.md"),"utf8")).toBe("user edit\n");
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it("rejects symlink parents and preview hash substitution",async()=>{
    const root=await mkdtemp(join(tmpdir(),"lane-onboarding-"));
    const outside=await mkdtemp(join(tmpdir(),"lane-onboarding-outside-"));
    try{
      await symlink(outside,join(root,"docs"));
      const edits=[{path:"docs/guide.md",expectedSha256:null,content:"# Escape\n"}],previewSha256=hash(JSON.stringify(edits));
      await expect(call({requestedHostId:"host-test",projectCwd:root,confirmed:true,previewSha256,edits})).rejects.toThrow("real directory");
      const mismatch=await call({requestedHostId:"host-test",projectCwd:root,confirmed:true,previewSha256:"0".repeat(64),edits});
      expect(mismatch.status).toBe("blocked");
      expect(await readFile(join(outside,"guide.md")).catch(()=>null)).toBeNull();
    }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
});
