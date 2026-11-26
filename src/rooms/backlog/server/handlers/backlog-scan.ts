import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import type { BacklogApi } from "../services/scanner";

export function mountBacklog(ctx: Pick<ServerCore, "isDisposed" | "log">, api: BacklogApi, engine?: WorkflowEngine): void {
  if (!engine) return;
  engine.register("lp.backlog_scan", {
    reentrant: true,
    run: async (c) => {
      if (ctx.isDisposed()) return { output: { scanned: 0, issued: 0 } };
      const rawProject = (() => { try { return c.resolve("$inputs.projectId"); } catch { return undefined; } })();
      const projectId = typeof rawProject === "string" && rawProject.trim() ? rawProject.trim() : undefined;
      try {
        const results = await api.scan(Date.now(), projectId ? { projectId, force: true } : undefined);
        return { output: { scanned: results.filter((r) => r.scanned).length, issued: results.filter((r) => r.offered !== null).length } };
      } catch (cause: unknown) {
        if (!ctx.isDisposed()) ctx.log(`backlog scan failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        throw cause;
      }
    },
  });
}
