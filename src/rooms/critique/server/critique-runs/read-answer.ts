import { helperExit } from "@lane-pilot/workflow-engine";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { parseCodeCritique } from "../../code-critique";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * One reading of a helper's answer for every stage (the hand-off standard, docs/guide/handoff.md). A helper that took the honest
 * exit throws `helper_blocked:…` with what it needs. An answer that cannot be read is sent back once to the same thread with the
 * parse error, so the helper repeats its answer and not its work (selfystudio 2026-10-30: an unescaped quote broke the JSON of a
 * «pass»). A second unreadable answer throws: the stage did not run, which is never the same as a stage with no findings.
 */
const REASK_WAIT_MS = 10 * 60_000;
export async function readAnswer<T>(bb:BbPluginApi, threadId:string|null|undefined, raw:string, parse:(text:string)=>T, keys:string, timeoutCode="critique_thread_timeout"):Promise<T> {
  const exit = helperExit(raw);
  if (exit) throw new Error(exit);
  try {
    return parse(raw);
  } catch (first) {
    if (!threadId) throw first;
    const why = (first instanceof Error ? first.message : String(first)).replace(/\s+/g, " ").slice(0, 600);
    const askedAt = Date.now();
    try {
      await bb.sdk.threads.send({ threadId, mode:"queue-if-active", input:[{ type:"text", mentions:[], text:`Lane Pilot: your answer could not be read (${why}). Do not redo the work: send the same answer again as one valid JSON object with the keys ${keys}, and nothing else; escape every quote inside a string.` }] } as never);
      // Repeating an answer is one short turn: a re-ask that BB never took in must not hold the stage forever.
      await waitThreadIdle(bb, threadId, timeoutCode, REASK_WAIT_MS, askedAt);
    } catch {
      throw first;
    }
    const again = (await bb.sdk.threads.output({ threadId })).output;
    if (typeof again !== "string" || !again.trim()) throw first;
    return parse(again);
  }
}
export const readCodeCritique = (bb:BbPluginApi, threadId:string|null|undefined, raw:string, cites:Parameters<typeof parseCodeCritique>[1]) =>
  readAnswer(bb, threadId, raw, (text) => parseCodeCritique(text, cites), "status, summary, findings and evidence");
