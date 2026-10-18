import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { HarnessApi } from "./harness";

export function harnessRpc(harness: HarnessApi) {
  return {
    harness_status: async ({ projectId }) => harness.status(projectId),
    harness_configure: async ({ projectId, patch }) => harness.setConfig(projectId, patch as never),
    harness_edit: async ({ projectId, area, writerKey, wait }) => {
      const run = harness.runEditor({ projectId, area: area ?? "", writerKey: writerKey ?? "*", reason: "manual" });
      if (wait) return await run;
      void run.catch(() => undefined);
      return { status: "started", detail: "the editor runs in the background; harness_status shows the trial when it lands", threadIds: [] };
    },
    harness_tick: async ({ projectId, dryRun }) => harness.tick(projectId, { dryRun }),
    harness_reflect: async ({ harnessId }) => harness.reflect(harnessId),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "harness_status" | "harness_configure" | "harness_edit" | "harness_tick" | "harness_reflect">;
}
