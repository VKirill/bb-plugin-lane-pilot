import { runOnHost } from "@lane-pilot/host-calls";
import { loadCandidates, findSolutionCommit, type Candidate, type HostPort } from "../../bench/server";
import type { ServerCore } from "../../core/server";
import { isSandboxProjectName } from "../../stability/server";
import { createCheckers, type CheckersApi } from "../api";
import { guardShellPort } from "../workspace";
import { loadHistory } from "../history";

/** The checker scorecard inside the plugin: candidates from the hub's history, checks on the machines through `runCommand`, no critics (see `model`). */
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
      const guarded: HostPort = {
        run: (hostId, cwd, command, timeoutSec = 120) =>
          guardShellPort({ run: (_dir, cmd, t) => hostPort.run(hostId, cwd, cmd, t) }, () => ({})).run(cwd, command, timeoutSec),
      };
      return await loadHistory({
        candidates: () => all, host: guarded, log: ctx.log,
        solutionCommit: (candidate) => findSolutionCommit(hostPort, byTask.get(candidate.taskId)!),
        scratch: () => "/tmp/lp-checkers/clones",
      }, options);
    },
    // The plugin starts no critic threads: model work is a graph, and the checker critics have none (no live scoring run has ever used them). The
    // code checkers and the drill need no model; the critics run from scripts/lp-checkers.ts (`--critic`), which asks through `bb thread spawn`.
    model: () => null,
  });
}
