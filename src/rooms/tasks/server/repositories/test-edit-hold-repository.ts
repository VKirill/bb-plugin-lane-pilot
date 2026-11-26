import { testEditAllowKey, testEditHoldKey, type TestEditHold } from "../../models/test-fit";

type HoldKv = { get(key:string):Promise<unknown>; set(key:string, value:never):Promise<unknown> };

async function readHoldList(kv:HoldKv, key:string):Promise<TestEditHold[]> {
  const kept = await kv.get(key);
  return Array.isArray(kept) ? kept.filter((row):row is TestEditHold => !!row && typeof row === "object" && typeof (row as TestEditHold).path === "string" && typeof (row as TestEditHold).afterSha256 === "string") : [];
}

/** What the attempt's last hand-in is held on: [{path, afterSha256}] of the edits the person has not allowed yet. */
export const testEditHoldOf = (kv:HoldKv, attemptId:string) => readHoldList(kv, testEditHoldKey(attemptId));

/** The edits a person allowed on this attempt: finish skips a hit only when path and content hash match one. */
export const testEditAllowance = (kv:HoldKv, attemptId:string) => readHoldList(kv, testEditAllowKey(attemptId));

/** Records an allowance for exactly the edits now held. */
export async function allowTestEditsOf(kv:HoldKv, attemptId:string, edits:readonly TestEditHold[]):Promise<void> {
  await kv.set(testEditAllowKey(attemptId), [...await testEditAllowance(kv, attemptId), ...edits] as never);
}
