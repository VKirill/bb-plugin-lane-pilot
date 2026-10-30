import { choice, choiceOf, defineJudgment, score, type Answers, type Jev } from "@lane-pilot/jev";
import { writerCandidates, type WriterProfile } from "@lane-pilot/models";
import { writerFallbackKeys, writerFallbackSlots, WRITER_FALLBACK_SLOTS } from "./writer-fallbacks";

/**
 * Which model writes a task (the owner's ask of 2026-10-25: the system picks the model for the task, not only the effort). Jev reads
 * the task and the writers' anamnesis (`WRITER_PROFILES`: strengths and weaknesses from public benchmarks and reviews) and chooses
 * one. An unclear pick (below `min_p`) keeps the project's own writer. The picked model writes the task; the project's writer becomes
 * its first fallback, the configured fallbacks follow.
 */
export const WRITER_MODEL_JUDGMENT_ID = "writer.model";

export type WriterPickTask = {
  title: string; objective: string; kind?: string | null; area?: string | null; risk?: string | null;
  owns_paths: readonly string[]; expected_outputs: readonly string[]; acceptance: readonly string[];
};
/** How busy a candidate's provider is now: the spent share of its usage window (null — not measured) and the writer tasks running on it. */
export type WriterLoad = { percent: number | null; running: number };
export type WriterPickInput = { task: WriterPickTask; candidates: readonly WriterProfile[]; load?: Readonly<Record<string, WriterLoad>> };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const COMPLEXITY_LEVELS = ["trivial: a rename, a config value, a one-line fix", "routine: a clear fix or a small change in a known place", "demanding: a feature, a refactor or a fix that needs exploring several paths", "frontier: open-ended design, architecture, deep debugging nobody has a recipe for"];
const RISK_LEVELS = ["cosmetic: a label, a colour, copy — nothing relies on it", "ordinary: behaviour people use, but no money, access or stored data", "serious: stored data, migrations, security, money or access"];

/** The level a Score answer settles on, as a share of its scale (0..1), from the probabilities it carries. */
const levelShare = (answers: Answers, id: string, levels: readonly string[]): number => {
  const answer = answers[id];
  if (answer?.type !== "score") return 0.5;
  const names = Object.keys(answer.probabilities);
  if (!names.length) return 0.5;
  return names.reduce((total, name) => total + (Math.max(0, levels.findIndex((level) => level.startsWith(name.split(":")[0]!))) / (levels.length - 1)) * (answer.probabilities[name] ?? 0), 0);
};

/** How much a candidate's provider busyness costs, in probability points (the balancing the question's text used to do). */
const loadPenalty = (load: WriterLoad | undefined): number => (load ? (load.percent ?? 0) / 100 * 0.06 + load.running * 0.01 : 0);
const TIER_RANK = { light: 0, standard: 1, strong: 2 } as const;

export const writerModelJudgment = defineJudgment<WriterPickInput, { key: string | null }>({
  id: WRITER_MODEL_JUDGMENT_ID,
  // v3: composite scoring — the Choice no longer hides «how hard is the task» and «what breaks» inside its criteria, and the
  // provider load moved out of the question into the decision code (weights we control).
  version: 3,
  defaultMode: "active",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    task: {
      title: clip(input.task.title, 300), objective: clip(input.task.objective, 1_500), kind: input.task.kind ?? null, area: input.task.area ?? null,
      risk: input.task.risk ?? null, files: input.task.owns_paths.slice(0, 30), outputs: input.task.expected_outputs.slice(0, 20),
      acceptance: input.task.acceptance.slice(0, 8).map((line) => clip(line, 300)),
    },
  }),
  questions: (input) => ({
    complexity: score("`task` is one coding task a writer agent will carry out: what it changes (`files`, `outputs`), why (`objective`), how it is checked (`acceptance`). How hard and open-ended is it?", COMPLEXITY_LEVELS),
    risk: score("What breaks if `task` is done wrong?", RISK_LEVELS),
    writer: choice(
      "`task` is one coding task a writer agent will carry out in a project's repository: what it changes (`files`, `outputs`), why (`objective`), how it is checked (`acceptance`), its kind and risk. Which coding model should write it? Judge by the work: the languages and stack the files show, how hard and open-ended the change is, how much it risks, and what each model is known to do well and badly. Prefer the cheaper model when it fits the task as well.",
      Object.fromEntries(input.candidates.map((profile) => [profile.key, `${profile.label}: ${profile.summary}`])),
    ),
  }),
  thresholds: {
    min_p: { default: 0.45, min: 0.3, max: 0.9, about: "least probability of the picked writer; below it the project's own writer writes" },
    near: { default: 0.12, min: 0.03, max: 0.4, about: "candidates within this of the top probability count as fitting about equally" },
    hard_at: { default: 0.66, min: 0.3, max: 1, about: "complexity or risk at this share of its scale allows a strong-tier model" },
  },
  decide(answers, t, input) {
    const pick = choiceOf(answers, "writer");
    if (!pick || pick.p < t.min_p!) return { decision: { key: null } };
    // The near band fits the task about equally: the choice between them is the weights — a strong-tier model only when the
    // task is hard (the «дороже при равном» ban), then the freest provider (load read in code, not in the question).
    const band = pick.ranked.filter(([id, p]) => pick.p - p <= t.near! && input.candidates.some((profile) => profile.key === id));
    const hard = levelShare(answers, "complexity", COMPLEXITY_LEVELS) >= t.hard_at! || levelShare(answers, "risk", RISK_LEVELS) >= t.hard_at!;
    const pool = hard ? band : band.filter(([id]) => TIER_RANK[input.candidates.find((profile) => profile.key === id)!.tier] < TIER_RANK.strong);
    const best = (pool.length ? pool : band).map(([id, p]) => [id, p - loadPenalty(input.load?.[id])] as [string, number]).sort((a, b) => b[1] - a[1])[0];
    return { decision: { key: best ? best[0] : null } };
  },
  fallback: () => ({ key: null }),
  describe: (decision) => decision.key ?? "configured",
});

/**
 * The settings keys a picked writer changes: the writer's pair and effort, and the chain behind it — the project's writer first,
 * then its configured fallbacks, one slot down. Null when the pick is the project's writer already.
 */
export function pickedWriterOverlay(settings: Record<string, unknown>, profile: WriterProfile): Record<string, unknown> | null {
  const provider = settings["writer.provider"], model = settings["writer.model"];
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return null;
  if (profile.providerId === provider && profile.model === model) return null;
  const chain = [{ providerId: provider, model, reasoningLevel: String(settings["writer.reasoning_effort"] ?? "medium") },
    ...writerFallbackSlots(settings).flatMap((row) => (row ? [row] : []))].filter((row) => !(row.providerId === profile.providerId && row.model === profile.model));
  const overlay: Record<string, unknown> = { "writer.provider": profile.providerId, "writer.model": profile.model, "writer.reasoning_effort": profile.reasoning, "writer.picked": profile.key };
  WRITER_FALLBACK_SLOTS.forEach((slot, index) => {
    const keys = writerFallbackKeys(slot), row = chain[index];
    overlay[keys.provider] = row?.providerId ?? "";
    overlay[keys.model] = row?.model ?? "";
    overlay[keys.effort] = row?.reasoningLevel ?? "";
  });
  return overlay;
}

type PickTaskContract = { title: string; display_title?: string; objective?: string; kind?: string; area?: string; risk?: string;
  owns_paths: readonly string[]; expected_outputs: readonly string[]; acceptance?: readonly string[] };

/**
 * The settings a task's writer changes, from Jev's pick; asked once per task and kept in the KV, so every attempt of the task runs on
 * the same writer. Null keeps the project's writer: the pick is off, Jev is off or unsure, or it picked the project's writer.
 */
export async function writerPickOverlay(deps: { kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }; jev: Pick<Jev, "judge" | "enabled"> | null; log(line: string): void;
  /** Whether a writer cannot work where this task runs now (ZCode: other machine, outside its free hours, busy); such a writer is not offered to Jev. A pick already kept for the task stands. */
  held?(profile: WriterProfile): Promise<boolean>;
  /** How busy each offered writer's provider is now; Jev spreads the tasks with it. */
  load?(profiles: readonly WriterProfile[]): Promise<Record<string, WriterLoad>> },
  settings: Record<string, unknown>, input: { projectId: string; runId: string; taskId: string; task: PickTaskContract }): Promise<Record<string, unknown> | null> {
  if (settings["writer.pick"] === false || settings["writer.pick"] === "off") return null;
  const key = `writer-pick:${input.runId}:${input.taskId}`;
  const candidates = writerCandidates(settings);
  const offered = deps.held ? (await Promise.all(candidates.map(async (profile) => ((await deps.held!(profile).catch(() => true)) ? null : profile)))).flatMap((profile) => (profile ? [profile] : [])) : candidates;
  // A key never written reads back undefined, not null: with a null check only, the pick was never asked (live 2026-10-25).
  let picked = ((await deps.kv.get(key).catch(() => null)) ?? null) as string | null;
  if (picked === null && offered.length > 1 && deps.jev?.enabled(settings as never)) {
    const task = input.task;
    const load = deps.load ? await deps.load(offered).catch(() => undefined) : undefined;
    const verdict = await deps.jev.judge(writerModelJudgment, { task: { title: task.display_title ?? task.title, objective: task.objective ?? "", kind: task.kind ?? null, area: task.area ?? null,
      risk: task.risk ?? null, owns_paths: task.owns_paths, expected_outputs: task.expected_outputs, acceptance: task.acceptance ?? [] }, candidates: offered, ...(load ? { load } : {}) },
      { projectId: input.projectId, runId: input.runId, subject: input.taskId, settings: settings as never }).catch(() => null);
    // Only a writer that was offered can be the answer (a held ZCode was not).
    picked = verdict?.by === "jev" && verdict.decision.key && offered.some((row) => row.key === verdict.decision.key) ? verdict.decision.key : "";
    await deps.kv.set(key, picked).catch(() => undefined);
    deps.log(`Lane Pilot writer pick: ${input.taskId} → ${picked || "the project's writer"}`);
  }
  const profile = picked ? candidates.find((row) => row.key === picked) : undefined;
  return profile ? pickedWriterOverlay(settings, profile) : null;
}
