import { acceptedRules, pickRelevantRules, ruleRelevanceQuestions, ruleRelevanceState } from "@lane-pilot/run-insights";
import type { MemorySettings } from "@lane-pilot/memory-core";
import type { TaskV2 } from "../../contracts";
import { mixWriterMemory } from "../../memory/server";
import type { LanePilotDatabase } from "../../storage";
import type { ServerCore } from "../../core/server";
import { stickyTurnPrompt } from "./writer-task";

/**
 * System One picks the accepted rules this task needs, so a writer's prompt does not carry every rule of the
 * project. Rules for the PM never reach a writer; rules marked for every task skip the question. Without an
 * answer every rule of that chunk goes in: a missing rule costs more than an extra one.
 */
export async function relevantWriterRules<T extends { rule:string; audience:string; always:boolean }>(host:ServerCore["host"], rules:T[], task:Record<string,unknown>, hostId:string):Promise<T[]> {
  const forWriter=rules.filter((rule)=>rule.audience!=="pm");
  const asked=forWriter.filter((rule)=>!rule.always);
  const chunks:T[][]=[];
  for(let start=0;start<asked.length;start+=8) chunks.push(asked.slice(start,start+8));
  const state=JSON.stringify(ruleRelevanceState(task)).slice(0,60_000);
  // Chunks are independent questions; asking them together keeps the wait at one answer (~0.5–1 s).
  const answered=await Promise.all(chunks.map(async(chunk)=>{
    const judged=await host.call("councilJudge",{requestedHostId:hostId,state,questions:ruleRelevanceQuestions(chunk)},{hostId,timeoutMs:10_000}).catch(()=>null);
    return judged?.status==="ok"?pickRelevantRules(chunk,judged.answers,judged.confidence??{},undefined,judged.probabilities??{}):chunk;
  }));
  const picked=new Set([...forWriter.filter((rule)=>rule.always),...answered.flat()]);
  return forWriter.filter((rule)=>picked.has(rule));
}

/**
 * What the project knows that a writer must be given for one task: the accepted rules that apply (the rules of the run's own
 * sections only, so a client's rule never reaches another client's writer) and at most three notes naming a path of the task plus
 * core conventions. The ONE place the first brief (`spawnWriterAttempt`), the turn that continues a writer thread
 * (`stickyTurnPrompt`) and the memory probe (`memory-probe`) take it from: a path that builds its own copy can stop delivering unseen.
 */
export type KnowledgeDeps={ db:LanePilotDatabase; host:ServerCore["host"]; chainForRun:(runId:string)=>Promise<readonly string[]> };
export type KnowledgeInput={ projectId:string; runId:string; hostId:string; task:TaskV2; memorySettings:MemorySettings };

/** The accepted rules that apply to one task, as the lines a brief or a turn carries; none when the project's memory is off. */
export async function writerRules(deps:KnowledgeDeps, input:KnowledgeInput) {
  const memoryOn=input.memorySettings.enabled&&input.memorySettings.inject;
  // Confirmed rules reach every writer; retrieval skips their records so they are not repeated as memory.
  const allRules=memoryOn?acceptedRules(deps.db,input.projectId,await deps.chainForRun(input.runId)):[];
  const rules=await relevantWriterRules(deps.host,allRules,input.task as unknown as Record<string,unknown>,input.hostId);
  return { allRules, rules, rulesText:rules.map((rule)=>`- ${rule.rule}`).join("\n") };
}

export async function writerKnowledge(deps:KnowledgeDeps, input:KnowledgeInput) {
  const memoryOn=input.memorySettings.enabled&&input.memorySettings.inject;
  const taskMemoryQuery=`${input.task.title}\n${input.task.objective}\n${input.task.acceptance.join(" ")}`;
  const { allRules, rules, rulesText }=await writerRules(deps,input);
  const ruleMemoryIds=new Set(allRules.map((rule)=>rule.memoryId));
  // The writer gets at most three notes that name a path of this task; other helpers keep the budgeted context.
  const mixed=memoryOn?mixWriterMemory(deps.db,{projectId:input.projectId,query:taskMemoryQuery,task:input.task,searchEngine:input.memorySettings.searchEngine,personalBot:input.memorySettings.personalBot,ruleMemoryIds,chain:await deps.chainForRun(input.runId)}):{text:"",ids:[] as string[]};
  return { allRules, rules, rulesText, mixed };
}

/**
 * The prompt of the turn that continues a writer thread. The next task of an area is a different contract, so the rules that apply to it
 * come with the turn (a retry or a merge is the same task: the first brief holds its rules). A rules lookup that fails sends none.
 */
export async function stickyTurnPromptWithRules(deps:KnowledgeDeps, know:KnowledgeInput, turn:Omit<Parameters<typeof stickyTurnPrompt>[0],"rulesText"|"conflicts">):Promise<(conflicts:string[])=>string> {
  const rulesText=turn.kind==="next-task"?await writerRules(deps,know).then((found)=>found.rulesText,()=>""):"";
  return (conflicts)=>stickyTurnPrompt({...turn,rulesText,conflicts});
}
