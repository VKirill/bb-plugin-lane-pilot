import type { FlakyEvidence, MachineReading } from "../../../contracts/machine-pressure";
export type { FlakyEvidence };
import { hollowRerun, noTestRanReason } from "../../../tasks/server";
import { flakyEvidence as machineEvidence, outputTail } from "../../../verification";

export async function runWithFlakyRerun<T extends {exitCode:number;stdout?:string;stderr?:string}>(command:string,run:()=>Promise<T>,log:(line:string)=>void,
  sample?:()=>Promise<MachineReading|null>):Promise<T&{flaky?:true;flakyEvidence?:FlakyEvidence;reran?:true;rerun?:{exitCode:number;stdout?:string;stderr?:string;hostError?:boolean;threw?:boolean}}> {
  const beforeFirst=await sample?.();
  const first=await run();
  if(first.exitCode===0||first.exitCode===124) return first;
  const beforeRerun=await sample?.();
  const again=await run();
  // A re-run the host never ran (hostError, a call that threw) keeps saying so: it reproduced nothing (SMA audit R-05).
  const broke=again as {hostError?:boolean;threw?:boolean};
  if(again.exitCode!==0) return {...first,reran:true,rerun:{exitCode:again.exitCode,stdout:again.stdout,stderr:again.stderr,...(broke.hostError?{hostError:true}:{}),...(broke.threw?{threw:true}:{})}};
  const hollow=hollowRerun(first,again);
  if(hollow) {
    log(`verification command exited 0 on re-run but did not run (${hollow}): ${command} — the first failure (exit ${first.exitCode}) stands`);
    return {...first,stderr:`${first.stderr??""}\nthe re-run exited 0 but ${hollow}; it is not a flaky pass, the first failure stands`.trim()};
  }
  const flakyEvidence=machineEvidence({exitCode:first.exitCode,outputTail:outputTail(first)},beforeFirst??null,beforeRerun??null);
  log(`verification command passed on re-run (flaky): ${command} — first exit ${first.exitCode}, ${flakyEvidence.classification}: ${flakyEvidence.basis}`);
  return {...again,flaky:true,flakyEvidence};
}


export function failIfNoTestRan<T extends {exitCode:number;stdout:string;stderr:string;command?:string}>(result:T):T {
  if(result.exitCode!==0) return result;
  const reason=noTestRanReason(`${result.stdout}\n${result.stderr}`,result.command);
  return reason ? {...result,exitCode:1,stderr:`check failed: ${reason}\n${result.stderr}`.trim()} : result;
}

/**
 * The baseline dirt an attempt's changes are measured against: everything the contract does not own, plus owned files
 * no earlier attempt of this task family produced. Only edits an earlier attempt of the same task family produced
 * leave the baseline, so an in-place redispatch counts its family's leftover work as produced, while owner or
 * other-task dirt in an owned file is never counted as produced.
 */
