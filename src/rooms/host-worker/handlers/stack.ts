import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../../contracts";
import { inventoryCoexistence, runCoexistenceOperation } from "../../native-install";
import { discoverClaudeAgents, prepareNativeClaude } from "../../native-agent";
import { prepareClaudeGuard } from "../../native-agent";
import { prepareBbShim } from "../../native-agent";
import {
  connectOpencodeStack,
  detectStack,
  importConfigStack,
  installStack,
  rollbackStack,
  snapshotStack,
  type HostContext,
} from "../../native-install";

function ctx(input: {
  requestedHostId: string;
  workspacePath?: string;
  threadStoragePath?: string;
  receiptDir?: string;
  confirmExternalOps?: boolean;
  localFallbackPath?: string;
  guardSourcePath?: string;
  pmWorkspacePath?: string;
  projectId?: string;
  snapshotPath?: string;
}): HostContext {
  return { ...input, moduleUrl: import.meta.url };
}

export const coexistenceInventory: ExperimentalHostRpcHandlers<typeof hostContract>["coexistenceInventory"] = async (input) => (
  inventoryCoexistence({ projectId: input.projectId, hostId: input.requestedHostId, targetSha: input.targetSha })
);

export const coexistenceOperation: ExperimentalHostRpcHandlers<typeof hostContract>["coexistenceOperation"] = async (input) => (
  runCoexistenceOperation({
    projectId: input.projectId,
    hostId: input.requestedHostId,
    operation: input.operation,
    manager: input.manager,
    path: input.path,
    expectedSha256: input.expectedSha256,
    snapshotId: input.snapshotId,
    targetSha: input.targetSha,
    confirmExternalOps: input.confirmExternalOps,
  })
);

export const detect: ExperimentalHostRpcHandlers<typeof hostContract>["detect"] = async (input) => {
  const detected = await detectStack(ctx(input));
  return {
    hostId: detected.hostId,
    laneStack: detected.laneStack,
    openCode: detected.openCode,
    workspace: detected.workspace,
    targetSha: detected.targetSha,
    matchesTarget: detected.matchesTarget,
    scenario: detected.scenario,
  };
};

export const snapshot: ExperimentalHostRpcHandlers<typeof hostContract>["snapshot"] = async (input) => (
  snapshotStack(ctx(input))
);

export const install: ExperimentalHostRpcHandlers<typeof hostContract>["install"] = async (input) => (
  installStack(ctx(input))
);

export const rollback: ExperimentalHostRpcHandlers<typeof hostContract>["rollback"] = async (input) => (
  rollbackStack(ctx(input))
);

export const importConfig: ExperimentalHostRpcHandlers<typeof hostContract>["importConfig"] = async (input) => (
  importConfigStack(ctx(input))
);

export const connectOpencode: ExperimentalHostRpcHandlers<typeof hostContract>["connectOpencode"] = async (input) => (
  connectOpencodeStack(ctx(input))
);

export const discoverClaudeAgentsHost: ExperimentalHostRpcHandlers<typeof hostContract>["discoverClaudeAgents"] = async (input) => (
  discoverClaudeAgents(input.cwd)
);

export const prepareNativeClaudeHost: ExperimentalHostRpcHandlers<typeof hostContract>["prepareNativeClaude"] = async (input, context) => (
  prepareNativeClaude({
    cwd: input.cwd,
    agentId: input.agentId,
    agentsJson: input.agentsJson,
    dataDir: context.experimental_paths.dataDir,
    signal: context.signal,
  })
);

export const prepareClaudeGuardHost: ExperimentalHostRpcHandlers<typeof hostContract>["prepareClaudeGuard"] = async (input, context) => (
  prepareClaudeGuard({
    role: input.role,
    cwd: input.cwd,
    dataDir: context.experimental_paths.dataDir,
  })
);

export const prepareBbShimHost: ExperimentalHostRpcHandlers<typeof hostContract>["prepareBbShim"] = async (_input, context) => (
  prepareBbShim({ dataDir: context.experimental_paths.dataDir })
);
