import { runOnHost } from "@lane-pilot/host-calls";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { loadCandidates, findSolutionCommit, type Candidate, type HostPort } from "../../bench/server";
import { fullAccessSpawn, stringAt, type ServerCore } from "../../core/server";
import { isSandboxProjectName } from "../../stability/server";
import { createCheckers, type CheckersApi } from "../api";
import type { ModelPort } from "../checkers";
import { loadHistory } from "../history";

const CRITIC_WAIT_MS = 240_000;

/** The checker scorecard inside the plugin: candidates from the hub's history, checks on the machines through `runCommand`, critics as hidden threads. */
export function createPluginCheckers(ctx: ServerCore): CheckersApi {
  const { bb, db, host } = ctx;
  const hostPort: HostPort = {
    run: async (hostId, cwd, command, timeoutSec = 120) => {
      const result = await runOnHost(host, { hostId, cwd, command, timeoutSec });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };

  const projectNames = async (): Promise<ReadonlyMap<string, string>> => {
    const rows = await bb.sdk.projects.list({ includePersonal: true } as never).catch(() => []) as Array<{ id?: unknown; name?: unknown }>;
    return new Map(rows.flatMap((row) => (typeof row.id === "string" && typeof row.name === "string" ? [[row.id, row.name] as const] : [])));
  };

  return createCheckers({
    db: db as never,
    log: ctx.log,
    async load(options) {
      const names = await projectNames();
      const all: Candidate[] = loadCandidates(db as never, { projectNames: names, isSandboxName: isSandboxProjectName }).candidates;
      const byTask = new Map(all.map((candidate) => [candidate.taskId, candidate]));
      return await loadHistory({
        candidates: () => all, host: hostPort, log: ctx.log,
        solutionCommit: (candidate) => findSolutionCommit(hostPort, byTask.get(candidate.taskId)!),
        scratch: () => "/tmp/lp-checkers/clones",
      }, options);
    },
    model({ providerId, model }): ModelPort {
      return {
        async ask(prompt, kind, where) {
          if (!where) throw new Error("a critic thread needs the candidate's project and folder");
          let threadId: string | null = null;
          try {
            const spawned = await fullAccessSpawn(bb, {
              projectId: where.projectId, providerId, model, prompt,
              environment: { type: "host", hostId: where.hostId, workspace: { type: "unmanaged", path: where.path } },
              visibility: "hidden", pluginMetadata: { role: `checker-${kind}` },
            } as never);
            threadId = stringAt(spawned, "id");
            if (!threadId) throw new Error("the critic thread did not start");
            await waitThreadIdle(bb, threadId, "checker_critic_timeout", CRITIC_WAIT_MS);
            const output = (await bb.sdk.threads.output({ threadId })).output;
            if (typeof output !== "string" || !output.trim()) throw new Error("the critic gave no output");
            return { text: output, tokens: null, costUsd: null };
          } finally {
            if (threadId) {
              await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
              await bb.sdk.threads.archive({ threadId }).catch(() => undefined);
            }
          }
        },
      };
    },
  });
}
