import { describe, expect, it } from "vitest";
import { reconcile, type IdempotencyTriple, type ReconcilePort } from "../src/reconcile";

const key: IdempotencyTriple = { lanePilotRunId:"run", lanePilotTaskId:"task", attemptId:"attempt" };
const metadata = (match:boolean) => match ? key : { lanePilotRunId:"other" };

function port(pages:string[][], matching:string[] = []): ReconcilePort {
  return {
    list: async ({offset,limit}) => pages[Math.floor(offset / limit)]?.map((id) => ({id})) ?? [],
    metadata: async (id) => metadata(matching.includes(id)),
  };
}

describe("E3 reconcile", () => {
  it("scans three threads with limit=1", async () => {
    await expect(reconcile(port([["a"],["b"],["c"],[]], ["c"]), key, {limit:1,maxPages:5}))
      .resolves.toEqual({kind:"found", threadId:"c"});
  });
  it("treats an exact multiple plus a short empty page as not_found", async () => {
    await expect(reconcile(port([["a"],["b"],[]]), key, {limit:1,maxPages:3}))
      .resolves.toEqual({kind:"not_found"});
  });
  it("blocks when page cap is reached without a short page", async () => {
    await expect(reconcile(port([["a"],["b"]]), key, {limit:1,maxPages:2}))
      .resolves.toEqual({kind:"blocked", reason:"page_cap"});
  });
  it("blocks ambiguous duplicate metadata", async () => {
    await expect(reconcile(port([["a","b"],[]], ["a","b"]), key, {limit:2,maxPages:3}))
      .resolves.toEqual({kind:"blocked", reason:"ambiguous"});
  });
  it("does not convert list errors to not_found", async () => {
    await expect(reconcile({list:async()=>{throw new Error("network")},metadata:async()=>({})}, key))
      .resolves.toEqual({kind:"error", message:"network"});
  });
});
