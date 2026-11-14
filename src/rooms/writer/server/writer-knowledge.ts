import { acceptedRules } from "@lane-pilot/run-insights";
import { embedQuery } from "../../memory/server";
import { DEFAULT_RELEVANCE_FLOOR, buildContextPack, clearsFloor, filesDrifted, memoryCandidates, pathsNamed, questionWords, recordRelevance, searchMemoryRecords, shadowPackCompare, wordFrequencies, type MemorySettings } from "@lane-pilot/memory-core";
import type { TaskV2 } from "../../contracts";
import { judgeWriterMemory, mixWriterMemory, snapshotFileRead, writerCandidates, writerMemoryPaths } from "../../memory/server";
import { getRunSettingsScopes, loadProjectSettings, taskBasePath, type LanePilotDatabase, latestAcceptedAttemptOfTask } from "../../storage";
import { getAttemptChange } from "../../rollback";
import { episodes } from "../../memory-tiers/server";
import { estimateTokens } from "@lane-pilot/memory-core";
import { readTaskApproach } from "../../tasks";
import type { WriterBriefContext } from "../../brief";
import type { ServerCore } from "../../contracts/server";
import { codeFactsState, CODE_FACTS_PROBE } from "../../platform";
import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort, maskCredentials } from "@lane-pilot/kit";
import { effectiveGroup, parseHelperContextSettings } from "../../contracts/helper-context";
import { stickyTurnPrompt } from "./writer-task";
import { projectPassportBlock } from "../../passport";

/**
 * The accepted rules that go to a writer: rules for the PM never reach a writer; every other rule goes in (a missing rule
 * costs more than an extra one, and no model narrows the list).
 */
export function relevantWriterRules<T extends { audience:string }>(rules:T[]):T[] {
  return rules.filter((rule)=>rule.audience!=="pm");
}

/**
 * What the project knows that a writer must be given for one task: the accepted rules that apply (the rules of the run's own
 * sections only, so a client's rule never reaches another client's writer) and at most three notes naming a path of the task plus
 * core conventions. The ONE place the first brief (`spawnWriterAttempt`), the turn that continues a writer thread
 * (`stickyTurnPrompt`) and the memory probe (`memory-probe`) take it from: a path that builds its own copy can stop delivering unseen.
 */
export type KnowledgeDeps={ db:LanePilotDatabase; host:ServerCore["host"]; chainForRun:(runId:string)=>Promise<readonly string[]>; log: (line:string)=>void;
  /** The kv store the approach notes live in (bb.storage.kv); without it similar works come without approach notes. */
  kv?:{ get(key:string):Promise<unknown> } };
export type KnowledgeInput={ projectId:string; runId:string; hostId:string; task:TaskV2; memorySettings:MemorySettings;
  /** Current bytes of a repo-relative path. A note about a file that changed since the note was stored is left out of the brief. */
  readBytes?:(path:string)=>Promise<Uint8Array|null> };

/** The accepted rules that apply to one task, as the lines a brief or a turn carries; none when the project's memory is off. */
export async function writerRules(deps:KnowledgeDeps, input:KnowledgeInput) {
  const memoryOn=input.memorySettings.enabled&&input.memorySettings.inject;
  // Confirmed rules reach every writer; retrieval skips their records so they are not repeated as memory.
  const allRules=memoryOn?acceptedRules(deps.db,input.projectId,await deps.chainForRun(input.runId),[...input.task.owns_paths,...input.task.read_first]):[];
  const rules=relevantWriterRules(allRules);
  return { allRules, rules, rulesText:rules.map((rule)=>`- ${rule.rule}`).join("\n") };
}

/**
 * The rules worded «WHEN <trigger> -> <act>» (SMA k_hs_reflex): the lines persistTaskFolder writes to REFLEXES.md so
 * the guard fires a burn lesson at the act it names. A rule in any other form is not a reflex and is left out.
 */
export function reflexLinesOf(rules: readonly string[]): string[] {
  return rules.filter((rule) => /WHEN\s+.+?\s*(?:→|->)\s*.+/.test(rule)).map((rule) => rule.startsWith("-") ? rule : `- ${rule}`).slice(0, 20);
}

/**
 * The confirmed notes that concern the paths of one task (SMA k_hs_context): «path -> claim» lines persistTaskFolder
 * writes to FILECARDS.md, so the guard's file-note stream shows them at the act. Only trust `confirmed` (an observed note
 * is a hunch); masked and clipped here because the line enters the model's context. Bounded: two notes a path, 40 lines.
 */
export async function taskFileCards(db:LanePilotDatabase, projectId:string, task:TaskV2):Promise<string[]> {
  const lines:string[]=[];
  for(const path of [...task.owns_paths,...task.read_first].slice(0,20)){
    const confirmed=searchMemoryRecords(db as never,projectId,path,8,"auto","subagent","").filter((note)=>note.trust==="confirmed");
    for(const note of confirmed.slice(0,2)){
      lines.push(maskCredentials(`${path} -> ${note.content.replace(/\s+/g," ").slice(0,200)}`).text);
    }
    if(lines.length>=40) break;
  }
  return lines.slice(0,40);
}

/**
 * Up to five accepted past tasks of the project that share the new task's words (SMA ap_similar): the writer reuses
 * what worked. Each line names the task, its approach note and the files its accepted merge changed; the block stays
 * inside a share of the brief's knowledge budget.
 */
export async function similarWorksLines(deps:KnowledgeDeps, input:KnowledgeInput, readApproach?:(runId:string,taskId:string)=>Promise<unknown>):Promise<string> {
  const query=`${input.task.title} ${input.task.objective}`;
  const past=episodes(deps.db,input.projectId,query,5,{state:"accepted",chain:await deps.chainForRun(input.runId),scopeMode:input.memorySettings.scope??"section"});
  if(!past.length) return "";
  const approach=readApproach??(deps.kv?(runId:string,taskId:string)=>readTaskApproach(deps.kv!,runId,taskId):undefined);
  const lines:string[]=[];
  for(const episode of past){
    const accepted=latestAcceptedAttemptOfTask(deps.db,episode.taskId);
    const files=(accepted?getAttemptChange(deps.db,accepted.id)?.changed:undefined)?.map((file)=>file.path).slice(0,20)??[];
    const note=accepted&&approach?await approach(accepted.run_id,episode.taskId).catch(()=>null):null;
    const noteText=note&&typeof note==="object"?(note as {approach?:unknown}).approach:null;
    lines.push(`- ${episode.taskId} «${episode.title}»: ${typeof noteText==="string"&&noteText.trim()?noteText.replace(/\s+/g," ").slice(0,300):"no approach note"}${files.length?` — files: ${files.join(", ")}`:""}`);
  }
  // A fifth of the knowledge budget at most: similar works are help, not the contract.
  const room=Math.max(200,Math.floor((input.memorySettings.contextBudget??1500)/5));
  const kept:string[]=[]; let used=estimateTokens("Similar works already done in this project:");
  for(const line of lines){ const cost=estimateTokens(line); if(used+cost>room) break; kept.push(line); used+=cost; }
  return kept.length?["Similar works already done in this project:",...kept].join("\n"):"";
}

/** The registry name GitNexus gave this checkout (~/.gitnexus/registry.json: a "name" line right above its "path" line). */
export const GITNEXUS_REPO_PROBE = `f="$HOME/.gitnexus/registry.json"; if [ -f "$f" ]; then for p in "$(pwd)" "$(pwd -P)"; do n=$(grep -B1 "\\"path\\": \\"$p\\"" "$f" | sed -n 's/.*"name": "\\([^"]*\\)".*/\\1/p' | head -1); if [ -n "$n" ]; then echo "REPO=$n"; break; fi; done; fi`;
export const gitnexusRepoOf = (probe: string | null | undefined): string | undefined => /^REPO=([\w.@-]+)\s*$/m.exec(probe ?? "")?.[1];

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
    const probe=gitnexusTools?(await bestEffort(deps.log, "writer gitnexus index probe", runOnHost(deps.host,{hostId:input.hostId,cwd:memoryRoot,command:`${CODE_FACTS_PROBE}; ${GITNEXUS_REPO_PROBE}`,timeoutSec:10}), null))?.stdout:null;
    const gitnexusIndex=gitnexusTools&&codeFactsState(probe).state!=="none";
    return {broadSkills:mode!=="roles"||skillsGroup.names===null,gitnexusTools,metamcpTools:mcpGroup.names===null||mcpGroup.names.includes("metamcp"),gitnexusIndex,gitnexusRepo:gitnexusRepoOf(probe)};
  })();
  const { allRules, rules, rulesText }=await writerRules(deps,input);
  const ruleMemoryIds=new Set(allRules.map((rule)=>rule.memoryId));
  // The writer gets at most three notes that name a path of this task; other helpers keep the budgeted context.
  const mixInput={projectId:input.projectId,query:taskMemoryQuery,task:input.task,searchEngine:input.memorySettings.searchEngine,personalBot:input.memorySettings.personalBot,ruleMemoryIds,kind:input.memorySettings.projectKind,tagNotes:input.memorySettings.tagNotes,scopeMode:input.memorySettings.scope??"section",chain:await deps.chainForRun(input.runId)};
  if(memoryOn) await embedQuery(taskMemoryQuery);
  const readFile=memoryOn&&input.readBytes?await snapshotFileRead(writerMemoryPaths(deps.db,mixInput),input.readBytes):undefined;
  // The judge (memory-judge.ts) answers once per task text: the cache keeps it ten minutes. A judge that fails leaves the vector's first five.
  const allowedIds=memoryOn?await judgeWriterMemory(deps.db,mixInput,input.memorySettings):null;
  const mixed=memoryOn?mixWriterMemory(deps.db,{...mixInput,readFile,allowedIds}):{text:"",ids:[] as string[]};
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
      const pack=buildContextPack({projectId:input.projectId,sectionChain:mixInput.chain,role:"writer",scopeMode:input.memorySettings.scope??"section",audience:input.memorySettings.audience,bot:input.memorySettings.personalBot,budget:input.memorySettings.contextBudget,floorDropIds,
        candidates:[...rules.map((rule)=>({id:rule.id,kind:"rule" as const,content:`- ${rule.rule}`,required:true,relevance:1})),...memoryCandidates(records,staleIds)]});
      const diff=shadowPackCompare([...mixed.ids,...rules.map((rule)=>rule.id)],mixed.text.length,pack);
      deps.log(`context-pack shadow ${pack.packId}: kept=${diff.kept.length} added=${diff.added.length} dropped=${diff.dropped.length} bytes ${diff.oldBytes}->${diff.packedBytes}`);
    } catch(cause) { deps.log(`context-pack shadow failed: ${cause instanceof Error?cause.message:String(cause)}`); }
  }
  const similar=memoryOn?await similarWorksLines(deps,input).catch(()=>""):"";
  const passport=memoryOn?projectPassportBlock(deps.db,{projectId:input.projectId,role:"writer",maxChars:1400}):"";
  const mixedWithPassport=passport?{...mixed,text:mixed.text?`${mixed.text}\n\n${passport}`:passport}:mixed;
  return { allRules, rules, rulesText, mixed:mixedWithPassport, briefContext, similar };
}

/**
 * The prompt of the turn that continues a writer thread. The next task of an area is a different contract, so the rules that apply to it
 * come with the turn (a retry or a merge is the same task: the first brief holds its rules). A rules lookup that fails sends none.
 */
export async function stickyTurnPromptWithRules(deps:KnowledgeDeps, know:KnowledgeInput, turn:Omit<Parameters<typeof stickyTurnPrompt>[0],"rulesText"|"conflicts">):Promise<(conflicts:string[])=>string> {
  const rulesText=turn.kind==="next-task"?await writerRules(deps,know).then((found)=>found.rulesText,()=>""):"";
  return (conflicts)=>stickyTurnPrompt({...turn,rulesText,conflicts});
}
