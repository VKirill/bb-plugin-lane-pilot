import { loadProjectSettings, loadPrototypeConfig, saveProjectSetting } from "../../../storage/database";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../../contracts";
import type { ServerCore } from "../../../../server/core";

export function stackRpc(ctx: ServerCore) {
  const { coexistenceInventory, coexistenceOperation, db, host, nativeInstaller } = ctx;
  return {
    stack_detect: async ({ projectId }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const [stack, coexistence] = await Promise.all([
        host.call("detect", { requestedHostId: config.hostId, workspacePath: config.writerWorkspacePath }, { hostId: config.hostId }),
        host.call("coexistenceInventory", { requestedHostId: config.hostId, projectId }, { hostId: config.hostId }),
      ]);
      return { ...stack, coexistence };
    },
    stack_install: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      if (!confirmExternalOps) return { schemaVersion:1, action:"install", status:"blocked", reason:"Explicit installation confirmation is required; no operation was run." };
      const result = await nativeInstaller.install(config.hostId);
      const receipt = { schemaVersion: 1, action: "install", status: "ok", native: result };
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_connect: async ({ projectId, confirmExternalOps }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      if (!confirmExternalOps) return { schemaVersion:1, action:"connect", status:"blocked", reason:"Explicit OpenCode connection confirmation is required; no operation was run." };
      const initial = await coexistenceInventory(projectId, config.hostId);
      const plugin = initial.managers.find((row) => row.manager === "opencode-plugin");
      const configRow = initial.managers.find((row) => row.manager === "opencode-config");
      if (!plugin || !configRow) throw new Error("Read-only inventory did not return the OpenCode plugin and config managers");
      const operations = [];
      const installed = await coexistenceOperation({
        projectId, hostId:config.hostId, operation:"install", manager:"opencode-plugin", path:plugin.path,
        expectedSha256:plugin.sha256, targetSha:initial.targetSha,
      });
      operations.push(installed);
      if (!(installed.status === "ok" || installed.status === "skipped")) {
        const receipt = { schemaVersion:1, action:"connect", status:installed.status, coexistenceOperations:operations };
        saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
        return receipt;
      }
      const current = await coexistenceInventory(projectId, config.hostId);
      const currentConfig = current.managers.find((row) => row.manager === "opencode-config" && row.path === configRow.path);
      if (!currentConfig) throw new Error("OpenCode configuration disappeared after plugin installation; no connection write was attempted");
      const connected = await coexistenceOperation({
        projectId, hostId:config.hostId, operation:"connect", manager:"opencode-config", path:currentConfig.path,
        expectedSha256:currentConfig.sha256, targetSha:current.targetSha,
      });
      operations.push(connected);
      const receipt = { schemaVersion:1, action:"connect", status:connected.status, coexistenceOperations:operations };
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
    stack_rollback: async ({ projectId, snapshotPath }) => {
      const config = loadPrototypeConfig(db, projectId);
      if (!config) throw new Error("Lane Pilot prototype is not configured for this project");
      const saved = loadProjectSettings(db, projectId)["install.lastReceipt"];
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(typeof saved === "string" ? saved : "");
        if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch { /* older installation receipt */ }
      const operations = Array.isArray(parsed?.coexistenceOperations)
        ? parsed.coexistenceOperations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : parsed && typeof parsed.manager === "string" && typeof parsed.path === "string" && typeof parsed.snapshotId === "string" ? [parsed] : [];
      if (operations.length) {
        const rolledBack: unknown[] = [];
        for (const previous of [...operations].reverse()) {
          if (typeof previous.manager !== "string" || typeof previous.path !== "string" || typeof previous.snapshotId !== "string") continue;
          const inventory = await coexistenceInventory(projectId, config.hostId);
          const row = inventory.managers.find((manager) => manager.manager === previous.manager && manager.path === previous.path);
          if (!row) {
            rolledBack.push({ manager:previous.manager, path:previous.path, status:"conflict", reason:"Owned manager/path is no longer in the current inventory; no arbitrary path rollback was attempted." });
            break;
          }
          const receipt = await coexistenceOperation({
            projectId, hostId:config.hostId, operation:"rollback", manager:previous.manager as "agents-marker"|"managed-checkout"|"claude-cache"|"claude-settings"|"opencode-config"|"opencode-plugin",
            path:previous.path, expectedSha256:row.sha256, snapshotId:previous.snapshotId, targetSha:inventory.targetSha,
          });
          rolledBack.push(receipt);
          if (!(receipt.status === "ok" || receipt.status === "rolled_back" || receipt.status === "skipped")) break;
        }
        const receipt = { schemaVersion:1, action:"rollback", status:rolledBack.every((item) => Boolean(item && typeof item === "object" && "status" in item && ["ok", "rolled_back", "skipped"].includes(String(item.status)))) ? "rolled_back" : "conflict", results:rolledBack };
        if (receipt.status === "rolled_back") saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
        else saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify({ ...parsed, lastRollbackAttempt:receipt }));
        return receipt;
      }
      if (!snapshotPath) throw new Error("No Lane Pilot coexistence snapshot is available and no legacy snapshot path was supplied.");
      const receipt = await host.call("rollback", {
        requestedHostId: config.hostId,
        snapshotPath,
      }, { hostId: config.hostId, timeoutMs: 180_000 });
      saveProjectSetting(db, projectId, "install.lastReceipt", JSON.stringify(receipt));
      return receipt;
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "stack_detect" | "stack_install" | "stack_connect" | "stack_rollback">;
}
