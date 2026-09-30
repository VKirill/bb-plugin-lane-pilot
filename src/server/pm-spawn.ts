import type { PrototypeConfig } from "../contracts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export function pmPrompt(runId: string, config: PrototypeConfig, managedWorkspace = false, native = false): string {
  if (native) {
    return [
      "You are the Lane Pilot PM in the selected role.",
      `Run id: ${runId}. Stay in this thread's current workspace.`,
      "Wait for the user's task. Do not write code, run write probes, or dispatch a writer until the user asks.",
    ].join("\n");
  }
  return [
    "You are the Lane Pilot PM. Do not write production code yourself.",
    managedWorkspace
      ? `Run id: ${runId}. This run is bound to the current BB-managed worktree; use the current workspace and do not target the base checkout at ${config.writerWorkspacePath}.`
      : `Run id: ${runId}. The production fixture is ${config.writerWorkspacePath}.`,
    "First use Bash only for read probes: `pwd`, `ls -la`, and `cat fixture/README.md` if available.",
    "Then demonstrate the guard by attempting a production write with Write or Bash redirection; report the denial.",
    "Delegate the safe fixture task with `lane_pilot_dispatch_writer`; it returns a runId and attemptId immediately, before the writer completes.",
    "Call `lane_pilot_wait_writer` with that runId (timeoutSec at most 240). If state is still running, call it again with the same runId. Return the final receipt to the user verbatim. Do not attempt to activate another PM.",
  ].join("\n");
}

/**
 * Every thread Lane Pilot starts (PM, writers, helpers) runs with full access. BB honours the mode only when it is
 * marked explicit; otherwise the project's remembered mode (often accept-edits) makes agents stop for approval.
 */

export function fullAccessSpawn(bb: BbPluginApi, args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) {
  return bb.sdk.threads.spawn({ ...args, permissionMode:"full",
    executionInputSources:{ ...args.executionInputSources, permissionMode:"explicit" } });
}
