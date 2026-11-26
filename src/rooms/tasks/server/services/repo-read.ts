import { isAbsolute, relative } from "node:path";
import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import { parseExecutionLineWindows } from "../../../contracts";
import { leavesSection, repoRootCommand } from "../../models/task-base";
import { parseReadFirstSelector } from "../../models/read-first";

/** Resolve on the workspace host, including for a writer checkout; never borrow the hub's filesystem or the live source root. */
export async function repoReadRoot(host:RunCommandHost, hostId:string, workspacePath:string, hints:readonly string[]):Promise<{root:string;prefix:string}|null> {
  if(!hints.some((raw)=>parseReadFirstSelector(raw).scope==="repo"||leavesSection(parseExecutionLineWindows(raw).path))) return null;
  const ran=await runOnHost(host,{hostId,cwd:workspacePath,command:repoRootCommand(workspacePath),timeoutSec:20});
  if(ran.hostId!==hostId) return null;
  const lines=ran.stdout.trim().split("\n");
  if(ran.exitCode!==0||lines.length!==2||!lines.every((line)=>isAbsolute(line.trim()))) return null;
  const root=lines[0]!.trim(), workspace=lines[1]!.trim();
  const prefix=relative(root,workspace).split("\\").join("/");
  if(prefix===".."||prefix.startsWith("../")||isAbsolute(prefix)) return null;
  return {root,prefix};
}
