import { isAbsolute } from "node:path";
import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import { parseExecutionLineWindows } from "../contracts";
import { leavesSection, parseRepoRoot, repoRootCommand } from "./task-base";
import { parseReadFirstSelector } from "./read-first";

/** Resolve on the workspace host, including for a writer checkout; never borrow the hub's filesystem or the live source root. */
export async function repoReadRoot(host:RunCommandHost, hostId:string, workspacePath:string, hints:readonly string[]):Promise<{root:string;prefix:string}|null> {
  if(!hints.some((raw)=>parseReadFirstSelector(raw).scope==="repo"||leavesSection(parseExecutionLineWindows(raw).path))) return null;
  const ran=await runOnHost(host,{hostId,cwd:workspacePath,command:repoRootCommand(workspacePath),timeoutSec:20});
  if(ran.hostId!==hostId) return null;
  const found=parseRepoRoot(ran);
  const lines=ran.stdout.trim().split("\n");
  if(!found||lines.length!==2||!lines.every((line)=>isAbsolute(line.trim()))) return null;
  return {root:lines[0]!.trim(),prefix:found.prefix};
}
