import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

type HostOptions = NonNullable<Parameters<typeof createFakePluginHost>[0]>;

/**
 * A fake host for a git project where every writer attempt gets its own worktree (decision 2026-10-06, no «in_place»).
 * The project's root source is another folder than the run's, so Lane Pilot makes the worktree itself through the host
 * functions answered here: a worktree starts clean, an integration merges, and every other host call goes to the
 * test's own handler. The test's dirt sequence therefore sees only the project-folder baseline and the writer's own
 * worktree, as it would see one attempt on a real machine.
 */
export function withOwnWorktrees(options: HostOptions, hostId: string, projectRoot = "/srv/project-root"): HostOptions {
  const inner = options.experimental_callHostRpc as ((call: { method: string; hostId: string; input: unknown }) => unknown) | undefined;
  const fresh = new Set<string>();
  return {
    ...options,
    sdk: {
      ...options.sdk,
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId, sources: [{ hostId, path: projectRoot }] }),
        list: async () => [],
        ...options.sdk?.projects,
      },
    } as never,
    experimental_callHostRpc: async (call: { method: string; hostId: string; input: unknown }) => {
      const input = (call.input ?? {}) as { name?: string; cwd?: string; command?: string };
      if (call.method === "gitCreateWorktree") {
        const path = `/tmp/lane-pilot-test-worktrees/${input.name}`;
        fresh.add(path);
        return { hostId, status: "ready", path, branch: `lane/${input.name}`, reason: null };
      }
      if (call.method === "gitPrepareWorktree" || call.method === "gitRemoveWorktree") return { hostId, status: "ready", reason: null };
      if (call.method === "gitIntegrate") return { hostId, status: "merged", commit: "d".repeat(40), conflicts: [], reason: null };
      if (call.method === "runCommand" && input.cwd && fresh.has(input.cwd) && String(input.command ?? "").includes("porcelain")) {
        fresh.delete(input.cwd);
        return { hostId, exitCode: 0, stdout: "[]", stderr: "" };
      }
      if (!inner) throw new Error(`unexpected host method ${call.method}`);
      return inner(call);
    },
  } as HostOptions;
}

/** createFakePluginHost with {@link withOwnWorktrees}. */
export function createFakeWorktreeHost(options: HostOptions, hostId: string) {
  return createFakePluginHost(withOwnWorktrees(options, hostId));
}
