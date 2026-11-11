import type { ServerCore } from "../../contracts/server";
import type { LeadRoadApi } from "../../contracts";
import { postOwnerItem } from "../../owner-waiting";
import { stripAnsi } from "@lane-pilot/kit";
import { testLabel } from "./gate-attribution";
import { continuesEpisode, type GateEpisode } from "./gate-episode";
import type { FailingTest } from "../gate-output";
import type { Services } from "./integration-gate";

/**
 * A red the batch did not cause (every failing test is red on the base) becomes a branch of the lead's road tree, class
 * next_step: «fix the pre-existing red test X in project P». A decides tier of the next tick acts on it without the owner;
 * a proposes tier still puts it to him as a proposal, which is the right place for it — not a bare «nobody is guilty» row.
 * One branch per (project, first failing tests): an open, proposed or already-deciding twin is enough.
 */
export function fileWithLead(ctx: ServerCore, services: Services, input: { runId: string; projectId: string }, tests: FailingTest[], logPath?: string): void {
  try {
    const db = ctx.db as never as Parameters<LeadRoadApi["listRoad"]>[0];
    const names = tests.map(testLabel).slice(0, 3).join(", ");
    const title = `Починить ранее красный тест: ${names} (проект ${input.projectId})`.slice(0, 300);
    const alive = services.leadRoad.listRoad(db, { projectId: input.projectId, state: ["open", "later", "proposed"], limit: 500 });
    if (alive.some((row) => row.title === title)) return;
    const rootId = `dir:${input.projectId}`;
    const root = services.leadRoad.getRoad(db, rootId) ?? services.leadRoad.addRoad(db, { id: rootId, projectId: input.projectId, title: `${input.projectId}: directions`, kind: "direction", source: "lead", why: "the root the lead files a project's branches under when a proposal names no parent" });
    services.leadRoad.addRoad(db, {
      parentId: root.id, projectId: input.projectId, title, kind: "option", source: "lead", class: "next_step",
      why: `Общая проверка после слияния красная, но все упавшие тесты падают и на базе до этой партии: ни одна слитая задача не виновата. Это работа, а не решение владельца: починить тест, который был сломан раньше.`,
      evidence: [
        { kind: "run", ref: input.runId, label: "красная проверка" },
        ...(logPath ? [{ kind: "file" as const, ref: logPath, label: "полный лог" }] : []),
        ...tests.slice(0, 5).map((test) => ({ kind: "note" as const, ref: testLabel(test).slice(0, 500), label: "упавший тест" })),
      ],
      costEstimate: "one fix",
    });
  } catch (cause) {
    ctx.log(`integration-gate: the pre-existing red was not filed to the lead's road: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * A red gate with no writer to fix it is a fact for the log and the owner's list, never a message into the PM chat: the gate runs
 * after the batch's last merge, when the run is often accepted and its PM done (2026-10-31: a gate note woke a finished PM two
 * hours later; the owner wants no event of the plugin's own in that chat, and since 2026-10-09 no question «what should the PM
 * do?» either). One row per red-gate episode: the same red again changes nothing.
 */
export function noteRed(ctx: ServerCore, input: { runId: string; projectId: string }, episode: GateEpisode, kind: string, what: string, why: string, logPath?: string): void {
  ctx.log(`integration-gate: ${stripAnsi(what)} ${stripAnsi(why)}`);
  postOwnerItem(ctx.db as never, {
    key: `gate-red:${input.runId}:${episode.startedAt}`, source: "integration-gate", kind, projectId: input.projectId, wake: false,
    what: stripAnsi(what), why: stripAnsi(why),
    evidence: [{ kind: "run", ref: input.runId }, ...(logPath ? [{ kind: "file" as const, ref: logPath }] : [])],
  });
}
/** A red run belongs to the run's current episode, or starts a new one (the owner's list has one row per episode). */
export function enterEpisode(episodes: Map<string, GateEpisode>, runId: string, command: string, files: string[]): GateEpisode {
  const known = episodes.get(runId);
  if (known && continuesEpisode(known, command, files)) {
    known.files = [...new Set([...known.files, ...files])];
    return known;
  }
  const episode: GateEpisode = { command, files: [...files], startedAt: Date.now() };
  episodes.set(runId, episode);
  return episode;
}
