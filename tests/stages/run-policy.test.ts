import {describe,it,expect} from "vitest";
import {buildRunExecutionProfile,buildRunPolicy,mapBounded,parseRunPolicy,RunWriterPool,shouldReconcileAttemptThread} from "../../src/stages/run-policy";

describe("run-v2 policy adapter",()=>{
  it("snapshots bounded pool settings and applies the configured verification cap in input order",async()=>{
    const policy=buildRunPolicy({"ops.pool_size":7,"ops.verify_pool_size":"3"});
    expect(policy).toEqual({schemaVersion:1,pools:{provider:7,verification:3}});
    let active=0,maxActive=0;
    const output=await mapBounded([4,3,2,1],policy.pools.verification,async(value)=>{
      active++;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,value));
      active--;return value*2;
    });
    expect(maxActive).toBe(3);
    expect(output).toEqual([8,6,4,2]);
  });

  it("rejects invalid pool snapshots and maps TaskV2 risk into the versioned run profile",()=>{
    expect(()=>buildRunPolicy({"ops.pool_size":11})).toThrow(/1 to 10/);
    expect(()=>parseRunPolicy({schemaVersion:2,pools:{provider:1,verification:1}})).toThrow();
    expect(buildRunExecutionProfile("critical",buildRunPolicy({}))).toMatchObject({score:10,risk:"high",sourceRisk:"critical",scoreAdapter:"task-risk-v1"});
  });

  it("bounds provider work per run and releases queued work in order",async()=>{
    const pool=new RunWriterPool();let active=0,maxActive=0;const started:number[]=[];
    await Promise.all([1,2,3,4].map(async(value)=>{
      const release=await pool.acquire("run-a",2);active++;maxActive=Math.max(maxActive,active);started.push(value);
      await new Promise(resolve=>setTimeout(resolve,4));active--;release();
    }));
    expect(maxActive).toBe(2);expect(started).toEqual([1,2,3,4]);
    const release=await pool.acquire("run-b",1);release();
  });

  it("resumes a durable queued attempt without requiring a thread reconcile",()=>{
    expect(shouldReconcileAttemptThread("queued")).toBe(false);
    expect(shouldReconcileAttemptThread("running")).toBe(true);
    expect(shouldReconcileAttemptThread("spawn_unknown")).toBe(true);
  });
});
