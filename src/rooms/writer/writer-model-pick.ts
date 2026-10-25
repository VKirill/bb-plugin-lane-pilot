import { choice, choiceOf, defineJudgment, type Jev } from "@lane-pilot/jev";
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
export type WriterPickInput = { task: WriterPickTask; candidates: readonly WriterProfile[] };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const writerModelJudgment = defineJudgment<WriterPickInput, { key: string | null }>({
  id: WRITER_MODEL_JUDGMENT_ID,
  version: 1,
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
    writer: choice(
      "`task` is one coding task a writer agent will carry out in a project's repository: what it changes (`files`, `outputs`), why (`objective`), how it is checked (`acceptance`), its kind and risk. Which coding model should write it? Judge by the work: the languages and stack the files show, how hard and open-ended the change is, how much it risks, and what each model is known to do well and badly. Prefer the cheaper model when it fits the task as well.",
      Object.fromEntries(input.candidates.map((profile) => [profile.key, `${profile.label}: ${profile.summary}`])),
    ),
  }),
  thresholds: {
    min_p: { default: 0.45, min: 0.3, max: 0.9, about: "least probability of the picked writer; below it the project's own writer writes" },
  },
  decide(answers, t, input) {
    const pick = choiceOf(answers, "writer");
    if (!pick || pick.p < t.min_p!) return { decision: { key: null } };
    return { decision: { key: input.candidates.some((profile) => profile.key === pick.top) ? pick.top : null } };
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
export async function writerPickOverlay(deps: { kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }; jev: Pick<Jev, "judge" | "enabled"> | null; log(line: string): void },
  settings: Record<string, unknown>, input: { projectId: string; runId: string; taskId: string; task: PickTaskContract }): Promise<Record<string, unknown> | null> {
  if (settings["writer.pick"] === false || settings["writer.pick"] === "off") return null;
  const key = `writer-pick:${input.runId}:${input.taskId}`;
  const candidates = writerCandidates(settings);
  // A key never written reads back undefined, not null: with a null check only, the pick was never asked (live 2026-10-25).
  let picked = ((await deps.kv.get(key).catch(() => null)) ?? null) as string | null;
  if (picked === null && candidates.length > 1 && deps.jev?.enabled(settings as never)) {
    const task = input.task;
    const verdict = await deps.jev.judge(writerModelJudgment, { task: { title: task.display_title ?? task.title, objective: task.objective ?? "", kind: task.kind ?? null, area: task.area ?? null,
      risk: task.risk ?? null, owns_paths: task.owns_paths, expected_outputs: task.expected_outputs, acceptance: task.acceptance ?? [] }, candidates },
      { projectId: input.projectId, runId: input.runId, subject: input.taskId, settings: settings as never }).catch(() => null);
    picked = verdict?.by === "jev" && verdict.decision.key ? verdict.decision.key : "";
    await deps.kv.set(key, picked).catch(() => undefined);
    deps.log(`Lane Pilot writer pick: ${input.taskId} → ${picked || "the project's writer"}`);
  }
  const profile = picked ? candidates.find((row) => row.key === picked) : undefined;
  return profile ? pickedWriterOverlay(settings, profile) : null;
}
