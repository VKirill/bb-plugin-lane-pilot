import { estimateTokens, recordMemoryMixed, recordMemoryReceipt } from "@lane-pilot/memory-core";
import { sha256Hex, stringAt, bestEffort } from "@lane-pilot/kit";
import { writerExecutionSelection } from "@lane-pilot/models";
import { briefMode, briefParts, STATE_MACHINE_VERSION } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { getReasoningTrace, saveReasoningTrace, TRANSITION_KEY, HARNESS_VERSION } from "../../storage";
import { buildExecutionPacket, renderExecutionPacket } from "../../tasks/execution-packet";
import { boundedAgentName } from "../../contracts/review-vocabulary";
import { listReturns, renderReturnNotes } from "../../stage-return";
import { HELPER_DISALLOWED_TOOLS, permissionEntries, WRITER_DISALLOWED_TOOLS } from "../../native-agent";
import { WriterSelectionError, helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { pipelineWriterTag } from "./pipeline-tag";
import { writerBriefInput, writerBriefSegments } from "./writer-task";
import { listTaskFolder } from "./spawn-probe";
import type { writerKnowledge } from "./writer-knowledge";
import type { createWriterSkillPick } from "./skill-pick";
import type { createSkillMaterializer } from "./skill-materialize";
import type { HarnessApi } from "../../harness/server/harness";
import type { SpawnInput, WriterEnvironment } from "./spawn-types";
import { spawnWithSeam } from "../spawn-seam";
import { fullAccessSpawn } from "../../platform/server";
import { resolve } from "node:path";

/**
 * Everything the writer thread is launched with: the execution packet, the picked and harness skills, the brief its
 * segments join into, the dispatch context saved on the reasoning trace, and the launch call itself.
 */
export async function buildWriterLaunch(deps:{
  bb:ServerCore["bb"]; db:ServerCore["db"];
  skillPick:ReturnType<typeof createWriterSkillPick>;
  skillMaterial:ReturnType<typeof createSkillMaterializer>;
  harness:HarnessApi|undefined;
}, args:{
  input:SpawnInput; settings:Record<string,unknown>;
  attemptTask:TaskV2; workspacePath:string; live:boolean;
  knowledge:Awaited<ReturnType<typeof writerKnowledge>>;
  relevantMemory:{text:string};
  writerProviderId:string; writerModel:string;
  execution:ReturnType<typeof writerExecutionSelection>;
  at:(step:string)=>void;
}):Promise<{ launch:(target:WriterEnvironment)=>Promise<unknown>; executionPacketSha256:string }> {
  const { bb, db, skillPick, skillMaterial } = deps;
  const { input, settings, attemptTask, workspacePath, live, knowledge, relevantMemory, writerProviderId, writerModel, execution, at } = args;
  const { allRules, rules, rulesText, mixed, briefContext } = knowledge;
  let executionPacket:string;
  let executionPacketSha256:string;
  try {
    const packet = await buildExecutionPacket(attemptTask.read_first, async (path) => {
      const file = await bb.sdk.files.read({ hostId:input.config.hostId, rootPath:workspacePath, path:resolve(workspacePath, path) });
      if (typeof file.content !== "string") return null;
      return { content:file.content, contentEncoding:file.contentEncoding, sha256:file.sha256, sizeBytes:file.sizeBytes };
    });
    executionPacket = renderExecutionPacket(packet);
    executionPacketSha256 = packet.sha256;
  } catch (cause) {
    throw new WriterSelectionError(`execution_packet_failed:${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const helperSnapshot = requireHelperSpawn({ bb, db, projectId:input.projectId, runId:input.runId });
  // Jev picks the task's skills before the writer starts; the picks and the PM's hints are the writer's extra access.
  at("skills");
  const writerSkills = await skillPick.pick({ attemptId:input.attemptId, projectId:input.projectId, hostId:input.config.hostId,
    projectCwd:input.task.project_cwd, task:input.task, plan:input.plan, settings });
  // An OpenCode writer's guard reads its skills from the worktree: the picked ones are linked there before it starts.
  const materialized = await skillMaterial.materialize({ attemptId:input.attemptId, hostId:input.config.hostId, workspacePath, live,
    providerId:writerProviderId, skills:writerSkills.skills, sources:writerSkills.sources });
  // OpenCode v2 compacts only by folder config; Lane Pilot compacts its writers itself.
  await skillMaterial.compactionOff({ attemptId:input.attemptId, hostId:input.config.hostId, workspacePath, live, providerId:writerProviderId });
  // The area's harness tree (src/rooms/harness): a candidate on trial or the adopted one adds its always-on lines,
  // memory notes, skills and checks on top of everything above; the base tree is empty and changes nothing.
  const writerKey=`${writerProviderId}/${writerModel}`;
  const harness=await deps.harness?.forAttempt({ projectId:input.projectId, area:input.task.area, writerKey, attemptId:input.attemptId }).catch((cause:unknown)=>{
    bb.log.warn(`Lane Pilot harness for ${input.attemptId} skipped: ${cause instanceof Error?cause.message:String(cause)}`); return null; }) ?? null;
  const harnessFiles=harness&&(harness.skillNames.length||harness.checkNames.length||"hooks.json" in harness.tree)
    ? await bestEffort(bb.log, "writer harness materialize", deps.harness!.materialize({ attemptId:input.attemptId, hostId:input.config.hostId, workspacePath, live, providerId:writerProviderId, parts:harness }), { written:[] as string[], reason:"error" })
    : { written:[] as string[], reason:null as string|null };
  const harnessSkills=harnessFiles.written.length?harness!.skillNames:[];
  // `writer.brief_mode=narrow` (src/rooms/contracts/brief-mode.ts): the contract and the plan only, no memory, rules or PM read summary.
  const brief=briefParts(briefMode(settings),{ rules:[rulesText, harness?.alwaysOn ?? ""].filter(Boolean).join("\n"),
    memory:[relevantMemory.text, harness?.memory ?? ""].filter(Boolean).join("\n"), pmRead:input.pmReadContext ?? "" });
  const briefRulesText=brief.rules;
  const briefMemoryText=brief.memory;
  const writerAgent = boundedAgentName(settings["writer.agent"],"Lane Pilot writer");
  const taskFolder = await listTaskFolder(bb, input.config.hostId, workspacePath, input.taskId);
  const contextSegments = writerBriefSegments(attemptTask,briefMemoryText,executionPacket,input.emergency&&!input.continuation
    ? "fallback"  // the reason stays in the trace; the writer is only told it is the fallback
    : undefined,writerAgent,brief.pmRead,briefRulesText,input.previousAttempt ?? "",taskFolder,live,
    // The real picks, so the brief's skills line names them instead of «the picked ones».
    { ...briefContext, skills: [...writerSkills.skills, ...harnessSkills] });
  // A fallback that continues the interrupted session reads its handoff right after its role line.
  const handoffSegments = input.continuation
    ? [contextSegments[0]!,{text:input.continuation.brief,hidden:true},...contextSegments.slice(1)]
    : contextSegments;
  // A task a person sent back to an earlier stage with a note (src/rooms/stage-return) carries every such note in its brief.
  const returnNotes = renderReturnNotes(listReturns(db, input.runId, input.taskId));
  const notesAt = input.continuation ? 2 : 1;
  const briefSegments = returnNotes ? [...handoffSegments.slice(0, notesAt), {text:returnNotes,hidden:true}, ...handoffSegments.slice(notesAt)] : handoffSegments;
  const writerBrief = briefSegments.map(segment=>segment.text).join("\n\n");
  // The permission list the launch asks for (SMA m_tl_terminal_parity): recorded on the trace beside the brief, so
  // `bb lane-pilot parity` can compare it with a terminal's own. A provider that cannot carry a policy still gets the launch.
  const writerPolicyField = (() => { try { return requiredPolicyField(bb, helperSnapshot, writerProviderId, "writer", { skills: [...writerSkills.skills, ...harnessSkills] }); } catch { return {}; } })();
  const writerPolicy = "experimental_vkRequiredSessionPolicy" in writerPolicyField ? writerPolicyField.experimental_vkRequiredSessionPolicy.policy : null;
  const existingTrace = getReasoningTrace(db, input.attemptId);
  if (existingTrace) {
    // The brief is final: each note in it counts one use; the attempt's acceptance later credits the same ids.
    recordMemoryMixed(db, input.projectId, mixed.ids);
    recordMemoryReceipt(db, { projectId: input.projectId, role: "writer", returnedIds: mixed.ids, packedIds: mixed.ids, tokens: estimateTokens(mixed.text) });
    // Held in a variable: the skill pick is not in the trace type, and code-repair reads it back from the saved trace.
    const dispatchContext = {
      memoryText:relevantMemory.text,
      memoryPicked:mixed.ids,
      rulesText,
      rulesPicked:{total:allRules.length,picked:rules.map((rule)=>rule.id)},
      executionPacket,
      executionPacketSha256,
      pmReadContext:input.pmReadContext ?? "",
      agent:writerAgent,
      promptChars:writerBrief.length,
      helperMode:helperSnapshot?.mode ?? "inherit",
      helperRequired:helperSnapshot?.policy?.required === true,
      skillPick:{...writerSkills, skills:[...writerSkills.skills, ...harnessSkills], materialized:[...materialized.linked, ...harnessSkills]},
      writerKey,
      harness:harness ? { id:harness.harnessId, arm:harness.arm, alwaysOnChars:harness.alwaysOn.length, skills:harnessSkills, checks:harnessFiles.written.length?harness.checkNames:[], materialize:harnessFiles.reason } : null,
      permissions: permissionEntries({ policy: writerPolicy, disallowedTools: `${HELPER_DISALLOWED_TOOLS},${WRITER_DISALLOWED_TOOLS}` }),
    };
    saveReasoningTrace(db, { ...existingTrace, dispatchContext,
      stamp:{ ...(existingTrace.stamp ?? { stateMachineVersion:STATE_MACHINE_VERSION, harnessVersion:HARNESS_VERSION }), transitionKey:TRANSITION_KEY, policySha256:sha256Hex(JSON.stringify(writerPolicy)) } });
  }
  const placement = await helperChildPlacement({
    bb, db, projectId:input.projectId, runId:input.runId,
    role:input.emergency ? "emergency-writer" : "writer",
    taskTitle:input.task.title,
  });
  const launchArgs = {
    ...placement,
    ...requiredPolicyField(bb, helperSnapshot, writerProviderId, "writer", { skills:[...writerSkills.skills, ...harnessSkills] }),
    ...execution,
    input: writerBriefInput(attemptTask, briefSegments, writerProviderId),
    pluginMetadata:{
      role:input.emergency ? "emergency-writer" : "writer",
      lanePilotRunId:input.runId,
      lanePilotTaskId:input.taskId,
      attemptId:input.attemptId,
      parentPmThreadId:input.pmThreadId,
      ...pipelineWriterTag(db, input.runId, input.taskId),
    },
  };
  const launch = (target:WriterEnvironment) => spawnWithSeam(() => fullAccessSpawn(bb, { ...launchArgs, environment:target }));
  return { launch, executionPacketSha256 };
}
