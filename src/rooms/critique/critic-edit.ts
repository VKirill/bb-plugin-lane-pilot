/** A critic the calibration marked low, plus the misses the proposal can quote. */
export type CriticEditRow = {
  stage: string;
  calibration: { low: boolean; labeled: number; hits: number; byModel: ReadonlyArray<{ model: string; low: boolean }> };
  missed: { examples: ReadonlyArray<{ taskId: string; reason: string }> };
};

/**
 * A prompt edit for a critic whose verdicts do not predict the outcome. Null when none is under the bar.
 * The text is the proposal; nothing here changes a prompt.
 */
export function criticPromptProposal(stats: readonly CriticEditRow[]): string | null {
  const low = stats.filter((row) => row.calibration.low);
  if (!low.length) return null;
  return low.map((row) => {
    const models = row.calibration.byModel.filter((item) => item.low).map((item) => item.model).join(", ") || "the role";
    const misses = row.missed.examples.map((item) => `${item.taskId}: ${item.reason}`).join("; ") || "none recorded";
    return `${row.stage} (${models}) matched ${row.calibration.hits} of ${row.calibration.labeled} outcomes. On the next pass, a fail needs the file and the line of what was missed. Misses: ${misses}.`;
  }).join("\n");
}

/** Trial stays closed unless the flag is on and the caller passed a bench. The proposal is not applied either way. */
export function criticEditGate(input: { trialOn: boolean; benchOn: boolean; proposal: string | null }): { status: "held" | "trial" | "skipped"; detail: string } {
  if (!input.proposal) return { status: "skipped", detail: "no critic is below the calibration bar" };
  if (!input.trialOn || !input.benchOn) return { status: "held", detail: "the proposal is stored; the trial stays off until critic.edit.trial is on and a bench is passed in" };
  return { status: "trial", detail: input.proposal };
}

/** KV flag. Absent means off. Set `{ on: true }` to let a run with `bench=on` leave the gate. */
export const CRITIC_EDIT_TRIAL_KEY = "lp.critic.edit.trial";

// ---------------------------------------------------------------- the trial loop (item 4): bench arms, decide, store or reject

export type CriticPromptStore = {
  /** The prompt a critic stage runs with now, and the versions it may roll back to. */
  current: { version: number; text: string; at: number } | null;
  history: Array<{ version: number; text: string; at: number; replacedBy: number | null }>;
};

export type CriticEditStore = {
  /** Accepted prompt per stage, with the rollback history. */
  prompts: Record<string, CriticPromptStore>;
  /** Candidates a trial retired: the proposal, why, when. The harness's rejected buffer, per stage. */
  rejected: Array<{ stage: string; proposal: string; reason: string; at: number }>;
};

const emptyStore = (): CriticEditStore => ({ prompts: {}, rejected: [] });
const readStore = (raw: unknown): CriticEditStore =>
  raw && typeof raw === "object" ? { prompts: (raw as CriticEditStore).prompts ?? {}, rejected: (raw as CriticEditStore).rejected ?? [] } : emptyStore();

type KvLike = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
const STORE_KEY = "lp.critic.edit.store";

/** The stored prompt of a stage, or null. */
export async function criticPromptOf(kv: KvLike, stage: string): Promise<string | null> {
  const store = readStore(await kv.get(STORE_KEY).catch(() => null));
  return store.prompts[stage]?.current?.text ?? null;
}

/** Roll a stage's prompt back one version; returns the prompt now current, or null when nothing is stored. */
export async function criticPromptRollback(kv: KvLike, stage: string, now = Date.now()): Promise<string | null> {
  const store = readStore(await kv.get(STORE_KEY).catch(() => null));
  const entry = store.prompts[stage];
  if (!entry?.current) return null;
  const prev = entry.history.filter((row) => row.replacedBy === entry.current!.version).at(-1) ?? null;
  entry.history.push({ ...entry.current, replacedBy: prev?.version ?? null });
  entry.current = prev ? { version: prev.version, text: prev.text, at: now } : null;
  entry.history = entry.history.filter((row) => row !== prev);
  await kv.set(STORE_KEY, store as never);
  return entry.current?.text ?? null;
}

export type CriticEditTrialOutcome =
  | { action: "adopt"; version: number; reason: string }
  | { action: "retire"; reason: string }
  | { action: "wait"; reason: string };

/**
 * Close the trial loop: a bench comparison row (passed/failed, as judgeSharedTrial consumes it) adopts or retires the
 * candidate prompt. Adopt writes it to the store under the next version with rollback history; retire appends it to
 * the rejected buffer. Anything but a decided verdict waits.
 */
export async function criticEditTrialSettle(input: {
  kv: KvLike; stage: string; proposal: string;
  /** What the bench decided, or null while the comparison is missing. */
  verdict: { passed: boolean; summary: string } | null;
  now?: number;
}): Promise<CriticEditTrialOutcome> {
  const now = input.now ?? Date.now();
  const store = readStore(await input.kv.get(STORE_KEY).catch(() => null));
  if (!input.verdict) return { action: "wait", reason: "no bench comparison yet" };
  if (input.verdict.passed) {
    const entry = store.prompts[input.stage] ?? { current: null, history: [] };
    const version = (entry.current?.version ?? 0) + 1;
    if (entry.current) entry.history.push({ ...entry.current, replacedBy: version });
    entry.current = { version, text: input.proposal, at: now };
    store.prompts[input.stage] = entry;
    await input.kv.set(STORE_KEY, store as never);
    return { action: "adopt", version, reason: `bench passed: ${input.verdict.summary}` };
  }
  store.rejected.push({ stage: input.stage, proposal: input.proposal, reason: input.verdict.summary, at: now });
  await input.kv.set(STORE_KEY, store as never);
  return { action: "retire", reason: `bench failed: ${input.verdict.summary}` };
}

/** Whether this proposal was already retired for the stage (a candidate once rejected is not tried again). */
export async function criticEditWasRejected(kv: KvLike, stage: string, proposal: string): Promise<boolean> {
  const store = readStore(await kv.get(STORE_KEY).catch(() => null));
  return store.rejected.some((row) => row.stage === stage && row.proposal === proposal);
}
