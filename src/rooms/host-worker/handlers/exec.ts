import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../../contracts";
import { prepareSandboxedCommandLine, releaseSandboxedCommandLine, runSandboxedCommandOnHost } from "../../verification";
import { runCommandOnHost } from "../../writer";
import { scanCritiqueCoverage } from "../../critique";
import { probeOpenCodeLimit } from "../opencode-limit";
import { runScriptOnHost } from "../script-run";

export const runScript: ExperimentalHostRpcHandlers<typeof hostContract>["runScript"] = async (input) => (
  runScriptOnHost(input)
);

export const runCommand: ExperimentalHostRpcHandlers<typeof hostContract>["runCommand"] = async (input) => (
  runCommandOnHost(input)
);

export const runSandboxedCommand: ExperimentalHostRpcHandlers<typeof hostContract>["runSandboxedCommand"] = async (input) => (
  runSandboxedCommandOnHost(input)
);

export const sandboxCommandLine: ExperimentalHostRpcHandlers<typeof hostContract>["sandboxCommandLine"] = async (input) => (
  prepareSandboxedCommandLine(input)
);

export const sandboxRelease: ExperimentalHostRpcHandlers<typeof hostContract>["sandboxRelease"] = async (input) => {
  await releaseSandboxedCommandLine({ tempPath:input.tempPath, created:input.created });
  return { hostId:process.env.BB_HOST_ID ?? input.requestedHostId, released:true };
};

/** The writer host asks its OpenCode v2 service about a silent writer's session (writer-silence.ts asks only for opencode2 writers). */
export const openCodeLimitProbe: ExperimentalHostRpcHandlers<typeof hostContract>["openCodeLimitProbe"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await probeOpenCodeLimit({sessionId:input.sessionId,sinceMs:input.sinceMs}),
});

export const inspectCritiqueCoverage: ExperimentalHostRpcHandlers<typeof hostContract>["inspectCritiqueCoverage"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await scanCritiqueCoverage({workspacePath:input.workspacePath,plan:input.plan,
    tasks:input.tasks.map((task)=>({id:task.id,lane:task.lane,owns_paths:task.ownsPaths,has_verification:task.hasVerification,
      verification:task.verification.map((command)=>({command:command.command,timeout_sec:command.timeoutSec}))}))}),
});
