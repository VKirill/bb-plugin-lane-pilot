import { describe, expect, it } from "vitest";
import { buildCandidateEvidence, MAX_FILE_EXCERPT_BYTES, sha256Text } from "../../src/rooms/critique/code-critique";
import { candidatePatches } from "../../src/rooms/critique/server";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

// selfystudio 2026-10-29: a 30-line edit in a large file cut the file to its first 8 KB and the gated code critic blocked every task
// with code_critique_evidence_unknown:packet_truncated (13 of 14 critiques that week). The packet now carries BB's diff of the change.
const big = `${"export const filler = 1;\n".repeat(800)}export const changed = 2;\n`;
const patch = "diff --git a/src/big.ts b/src/big.ts\n@@ -801 +801 @@\n-export const changed = 1;\n+export const changed = 2;\n";
const base = { produced:["src/big.ts"], hashes:{ "src/big.ts": sha256Text(big) }, baselineHashes:{ "src/big.ts": "old" },
  verification:[{ command:"npm test", exitCode:0, stdout:"ok", stderr:"" }], output:"done", ownsPaths:["src/**"], neverTouch:[], dirtOk:true };

describe("code critic packet", () => {
  it("shows a large file's change as its diff and stays complete evidence", () => {
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_FILE_EXCERPT_BYTES);
    const evidence = buildCandidateEvidence({ ...base, files:[{ path:"src/big.ts", content:big }], patches:{ "src/big.ts": patch } });
    expect(evidence.truncated).toBe(false);
    expect(evidence.files[0]?.diff).toBe(patch);
    expect(evidence.files[0]?.content).toBe("");
  });

  it("still calls a large file without a diff unknown evidence", () => {
    const evidence = buildCandidateEvidence({ ...base, files:[{ path:"src/big.ts", content:big }] });
    expect(evidence.truncated).toBe(true);
    expect(evidence.truncateReason).toContain("packet_truncated");
  });

  it("keeps a small file whole next to its diff", () => {
    const small = "export const a = 1;\n";
    const evidence = buildCandidateEvidence({ ...base, hashes:{ "src/big.ts": sha256Text(small) }, files:[{ path:"src/big.ts", content:small }], patches:{ "src/big.ts": patch } });
    expect(evidence.truncated).toBe(false);
    expect(evidence.files[0]?.content).toBe(small);
  });

  it("reads the diff from BB in the attempt's environment and leaves out what BB cut", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id:"t1", runId:"run1", kind:"bb", contract:{ id:"t1", project_cwd:"/wt/t1" } as never });
    createAttempt(db, { id:"a1", runId:"run1", taskId:"t1" });
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/wt/t1', environment_id='env_attempt' WHERE id='a1'").run();
    const asked: unknown[] = [];
    const fake = { sdk:{ environments:{
      list:async () => [{ id:"env_folder" }],
      diffPatch:async (args:unknown) => { asked.push(args); return { outcome:"available", patches:[
        { path:"src/big.ts", patch, truncated:false }, { path:"src/huge.ts", patch:"cut", truncated:true }, { path:"other.ts", patch:"x", truncated:false }] }; },
    } } };
    const patches = await candidatePatches(fake, db, { runId:"run1", taskId:"t1", hostId:"h1", cwd:"/wt/t1", paths:["src/big.ts", "src/huge.ts"] });
    expect(patches).toEqual({ "src/big.ts": patch });
    expect(asked).toEqual([{ environmentId:"env_attempt", paths:["src/big.ts", "src/huge.ts"], target:{ type:"uncommitted" } }]);
    const none = await candidatePatches({ sdk:{ environments:{ list:async () => [], diffPatch:async () => { throw new Error("no"); } } } }, db,
      { runId:"run1", taskId:"t2", hostId:"h1", cwd:"/other", paths:["a.ts"] });
    expect(none).toEqual({});
  });

  it("reads the diff through the bb--git plugin's files and keyed patches when callRpc is there", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id:"t1", runId:"run1", kind:"bb", contract:{ id:"t1", project_cwd:"/wt/t1" } as never });
    createAttempt(db, { id:"a1", runId:"run1", taskId:"t1" });
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/wt/t1', environment_id='env_attempt' WHERE id='a1'").run();
    const calls: Array<{ method:string; input:unknown }> = [];
    const fake = { sdk:{
      environments:{ list:async () => [{ id:"env_folder" }] },
      plugins:{ callRpc:async (args:{ pluginId:string; method:string; input?:unknown }) => {
        calls.push({ method:args.method, input:args.input });
        if (args.method === "files") return { outcome:"available", files:[
          { path:"src/big.ts", revision:"r1" }, { path:"src/huge.ts", revision:"r2" }, { path:"src/gone.ts", revision:"r3" }],
          initialPatches:[{ path:"src/big.ts", patch, truncated:false }] };
        if (args.method === "patches") {
          const keys = (args.input as { keys:string[] }).keys;
          expect(keys).toEqual([
            JSON.stringify(["env_attempt", { type:"uncommitted" }, false, "src/huge.ts", "r2"]),
            JSON.stringify(["env_attempt", { type:"uncommitted" }, false, "src/gone.ts", "r3"]),
          ]);
          return Object.fromEntries(keys.map((key, index) => [key, { outcome:"available",
            patch:{ path:["src/huge.ts", "src/gone.ts"][index], patch:index === 0 ? "cut" : "gone-diff", truncated:index === 0 } }]));
        }
        throw new Error(`unexpected ${args.method}`);
      } },
    } };
    const patches = await candidatePatches(fake, db, { runId:"run1", taskId:"t1", hostId:"h1", cwd:"/wt/t1", paths:["src/big.ts", "src/huge.ts", "src/gone.ts", "src/unchanged.ts"] });
    expect(patches).toEqual({ "src/big.ts": patch, "src/gone.ts": "gone-diff" });
    expect(calls.map((call) => call.method)).toEqual(["files", "patches"]);
  });

  it("returns nothing when bb--git reports the environment cannot be diffed", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id:"t1", runId:"run1", kind:"bb", contract:{ id:"t1", project_cwd:"/wt/t1" } as never });
    const fake = { sdk:{
      environments:{ list:async () => [{ id:"env_folder" }] },
      plugins:{ callRpc:async () => ({ outcome:"unavailable", failure:{ code:"not_git_repo", workspacePath:"/wt/t1", message:"no repo" } }) },
    } };
    expect(await candidatePatches(fake, db, { runId:"run1", taskId:"t1", hostId:"h1", cwd:"/wt/t1", paths:["src/big.ts"] })).toEqual({});
  });
});
