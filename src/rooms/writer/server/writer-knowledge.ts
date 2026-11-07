import { acceptedRules, pickRelevantRules, ruleRelevanceQuestions, ruleRelevanceState } from "@lane-pilot/run-insights";
import { embedQuery } from "../../memory/server";
import { DEFAULT_RELEVANCE_FLOOR, buildContextPack, clearsFloor, filesDrifted, memoryCandidates, pathsNamed, questionWords, recordRelevance, shadowPackCompare, wordFrequencies, type MemorySettings } from "@lane-pilot/memory-core";
import type { TaskV2 } from "../../contracts";
import { mixWriterMemory, snapshotFileRead, writerCandidates, writerMemoryPaths } from "../../memory/server";
import { getRunSettingsScopes, loadProjectSettings, taskBasePath, type LanePilotDatabase } from "../../storage";
import type { WriterBriefContext } from "../../brief";
import type { ServerCore } from "../../contracts/server";
import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort } from "@lane-pilot/kit";
import { effectiveGroup, parseHelperContextSettings } from "../../contracts/helper-context";
import { stickyTurnPrompt } from "./writer-task";

/**
 * System One picks the accepted rules this task needs, so a writer's prompt does not carry every rule of the
 * project. Rules for the PM never reach a writer; rules marked for every task skip the question. Without an
 * answer every rule of that chunk goes in: a missing rule costs more than an extra one.
 */
export async function relevantWriterRules<T extends { rule:string; audience:string; always:boolean }>(host:ServerCore["host"], rules:T[], task:Record<string,unknown>, hostId:string, log: (line:string)=>void):Promise<T[]> {
  const forWriter=rules.filter((rule)=>rule.audience!=="pm");
  const asked=forWriter.filter((rule)=>!rule.always);
  const chunks:T[][]=[];
  for(let start=0;start<asked.length;start+=8) chunks.push(asked.slice(start,start+8));
  const state=JSON.stringify(ruleRelevanceState(task)).slice(0,60_000);
  // Chunks are independent questions; asking them together keeps the wait at one answer (~0.5–1 s).
  const answered=await Promise.all(chunks.map(async(chunk)=>{
    const judged=await bestEffort(log, "writer rule relevance", host.call("councilJudge",{requestedHostId:hostId,state,questions:ruleRelevanceQuestions(chunk)},{hostId,timeoutMs:10_000}), null);
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
export type KnowledgeDeps={ db:LanePilotDatabase; host:ServerCore["host"]; chainForRun:(runId:string)=>Promise<readonly string[]>; log: (line:string)=>void };
export type KnowledgeInput={ projectId:string; runId:string; hostId:string; task:TaskV2; memorySettings:MemorySettings;
  /** Current bytes of a repo-relative path. A note about a file that changed since the note was stored is left out of the brief. */
  readBytes?:(path:string)=>Promise<Uint8Array|null> };

/** The accepted rules that apply to one task, as the lines a brief or a turn carries; none when the project's memory is off. */
export async function writerRules(deps:KnowledgeDeps, input:KnowledgeInput) {
  const memoryOn=input.memorySettings.enabled&&input.memorySettings.inject;
  // Confirmed rules reach every writer; retrieval skips their records so they are not repeated as memory.
  const allRules=memoryOn?acceptedRules(deps.db,input.projectId,await deps.chainForRun(input.runId),[...input.task.owns_paths,...input.task.read_first]):[];
  const rules=await relevantWriterRules(deps.host,allRules,input.task as unknown as Record<string,unknown>,input.hostId,deps.log);
  return { allRules, rules, rulesText:rules.map((rule)=>`- ${rule.rule}`).join("\n") };
}

export async function writerKnowledge(deps:KnowledgeDeps, input:KnowledgeInput) {
  const memoryOn=input.memorySettings.enabled&&input.memorySettings.inject;
  const taskMemoryQuery=`${input.task.title}\n${input.task.objective}\n${input.task.acceptance.join(" ")}`;
  // The brief's context (writerBriefSegments): whether skills are truly broad, which tools the role allows, .gitnexus presence.
  const briefContext = await (async (): Promise<WriterBriefContext> => {
    const parsed=parseHelperContextSettings(loadProjectSettings(deps.db,input.projectId,getRunSettingsScopes(deps.db,input.runId)));
    const mode=parsed.ok?parsed.settings.mode:"roles";
    const access=parsed.ok?parsed.settings.roleAccess?.writer:undefined;
    const skillsGroup=mode==="roles"?effectiveGroup("writer","skills",access):{names:null};
    const mcpGroup=mode==="roles"?effectiveGroup("writer","mcpServers",access):{names:null};
    const gitnexusTools=mcpGroup.names===null||mcpGroup.names.includes("gitnexus");
    const memoryRoot=taskBasePath(deps.db,input.runId,input.task.id)??input.task.project_cwd;
    const gitnexusIndex=gitnexusTools&&(await bestEffort(deps.log, "writer gitnexus index probe", runOnHost(deps.host,{hostId:input.hostId,cwd:memoryRoot,command:"test -d .gitnexus",timeoutSec:10}), null))?.exitCode===0;
    return {broadSkills:mode!=="roles"||skillsGroup.names===null,gitnexusTools,metamcpTools:mcpGroup.names===null||mcpGroup.names.includes("metamcp"),gitnexusIndex};
  })();
  const { allRules, rules, rulesText }=await writerRules(deps,input);
  const ruleMemoryIds=new Set(allRules.map((rule)=>rule.memoryId));
  // The writer gets at most three notes that name a path of this task; other helpers keep the budgeted context.
  const mixInput={projectId:input.projectId,query:taskMemoryQuery,task:input.task,searchEngine:input.memorySettings.searchEngine,personalBot:input.memorySettings.personalBot,ruleMemoryIds,kind:input.memorySettings.projectKind,chain:await deps.chainForRun(input.runId)};
  if(memoryOn) await embedQuery(taskMemoryQuery);
  const readFile=memoryOn&&input.readBytes?await snapshotFileRead(writerMemoryPaths(deps.db,mixInput),input.readBytes):undefined;
  const mixed=memoryOn?mixWriterMemory(deps.db,{...mixInput,readFile}):{text:"",ids:[] as string[]};
  // M4 shadow: one pack is compiled from the same sources next to the legacy mix and compared; nothing it builds is delivered.
  if(memoryOn&&input.memorySettings.packMode!=="off"){
    try {
      const records=writerCandidates(deps.db,mixInput);
      // Freshness: a note whose named files drifted is marked stale for re-verification, not delivered silently.
      const staleIds=readFile?new Set(records.filter((record)=>filesDrifted(record.fileFingerprint,pathsNamed(record.content),readFile)).map((record)=>record.id)):undefined;
      // M6: the same relevance floor the query paths use — a note under the threshold is excluded, rules are not floored.
      const relevance=recordRelevance(wordFrequencies(deps.db,input.projectId,"subagent",input.memorySettings.personalBot),taskMemoryQuery,records);
      const words=questionWords(taskMemoryQuery);
      const floorDropIds=input.memorySettings.queryFloor===false?undefined:new Set(records.filter((record)=>!clearsFloor(relevance.get(record.id)!,DEFAULT_RELEVANCE_FLOOR,words)).map((record)=>record.id));
      const pack=buildContextPack({projectId:input.projectId,sectionChain:mixInput.chain,role:"writer",audience:input.memorySettings.audience,bot:input.memorySettings.personalBot,budget:input.memorySettings.contextBudget,floorDropIds,
        candidates:[...rules.map((rule)=>({id:rule.id,kind:"rule" as const,content:`- ${rule.rule}`,required:true,relevance:1})),...memoryCandidates(records,staleIds)]});
      const diff=shadowPackCompare([...mixed.ids,...rules.map((rule)=>rule.id)],mixed.text.length,pack);
      deps.log(`context-pack shadow ${pack.packId}: kept=${diff.kept.length} added=${diff.added.length} dropped=${diff.dropped.length} bytes ${diff.oldBytes}->${diff.packedBytes}`);
    } catch(cause) { deps.log(`context-pack shadow failed: ${cause instanceof Error?cause.message:String(cause)}`); }
  }
  return { allRules, rules, rulesText, mixed, briefContext };
}

/**
 * The prompt of the turn that continues a writer thread. The next task of an area is a different contract, so the rules that apply to it
 * come with the turn (a retry or a merge is the same task: the first brief holds its rules). A rules lookup that fails sends none.
 */
export async function stickyTurnPromptWithRules(deps:KnowledgeDeps, know:KnowledgeInput, turn:Omit<Parameters<typeof stickyTurnPrompt>[0],"rulesText"|"conflicts">):Promise<(conflicts:string[])=>string> {
  const rulesText=turn.kind==="next-task"?await writerRules(deps,know).then((found)=>found.rulesText,()=>""):"";
  return (conflicts)=>stickyTurnPrompt({...turn,rulesText,conflicts});
}
