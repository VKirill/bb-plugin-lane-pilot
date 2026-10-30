import { resolve } from "node:path";

type ThreadSdk = {
  threads: { get(input: { threadId: string }): Promise<unknown> };
  environments: { get(input: { environmentId: string }): Promise<unknown> };
};

/**
 * The folder a writer thread now works in, when it is not its attempt's worktree. A writer can move its own thread
 * (BB's update_environment_directory): T3.3 of magicseo (2026-10-30) found its worktree gone, switched to the main
 * checkout, and its next turn would have written there. Null when the thread stays put or the lookup fails.
 */
export async function writerLeftWorktree(sdk: ThreadSdk, threadId: string, workspacePath: string): Promise<string | null> {
  const thread = await sdk.threads.get({ threadId }).catch(() => null) as { environmentId?: unknown } | null;
  if (typeof thread?.environmentId !== "string") return null;
  const environment = await sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null) as { path?: unknown } | null;
  if (typeof environment?.path !== "string" || !environment.path) return null;
  // The thread's environment may sit at the worktree's root while the task works in a subfolder of it, or the other way round.
  const [env, own] = [resolve(environment.path), resolve(workspacePath)];
  return env === own || own.startsWith(`${env}/`) || env.startsWith(`${own}/`) ? null : environment.path;
}
