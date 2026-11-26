import { bestEffort } from "@lane-pilot/kit";
import { mergeIntentKey, type MergeIntent, type RunOnHost } from "../../models/merge-intent";

export type MergeIntentKv = {
  get(key: string): Promise<unknown>;
  set(key: string, value: never): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(prefix?: string): Promise<string[]>;
};

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** Writes the intent. A machine that cannot tell the heads still gets one (the attempt's trailer in the merge commit identifies the merge); a KV failure never blocks the merge. */
export async function recordMergeIntent(
  kv: MergeIntentKv,
  run: RunOnHost,
  input: Omit<MergeIntent, "branch" | "sha" | "baseHead" | "at">,
  log: (message: string) => void = console.warn,
): Promise<void> {
  const heads = await bestEffort(
    log,
    `merge intent heads ${input.attemptId}`,
    run(
      input.hostId,
      input.basePath,
      `git rev-parse HEAD; git -C ${quote(input.worktreePath)} rev-parse HEAD; git -C ${quote(input.worktreePath)} rev-parse --abbrev-ref HEAD`,
    ),
    null,
  );
  const [baseHead, sha, branch] = heads && heads.exitCode === 0 ? heads.stdout.split("\n").map((line) => line.trim()) : [];
  const intent: MergeIntent = { ...input, baseHead: baseHead || null, sha: sha || null, branch: branch || null, at: Date.now() };
  await bestEffort(log, `merge intent write ${input.attemptId}`, kv.set(mergeIntentKey(input.attemptId), intent as never), undefined);
}

export async function clearMergeIntent(
  kv: Pick<MergeIntentKv, "delete">,
  attemptId: string,
  log: (message: string) => void = console.warn,
): Promise<void> {
  await bestEffort(log, `merge intent clear ${attemptId}`, kv.delete(mergeIntentKey(attemptId)), undefined);
}
