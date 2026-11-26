import { type ServerCore } from "../../../contracts/server";
import { loadProjectSettings, saveProjectSetting } from "../../../storage";
import { FIRST_RUN_STEPS, answerFirstRun, firstRunNeeded, firstRunSettings, type FirstRunDraft, type FirstRunStep } from "../../models/first-run";

const draftKey = (projectId: string) => `lp.front.first-run:${projectId}`;

/**
 * First-run onboarding server state: four steps into a draft, then written once into project settings.
 */
export function createFront(ctx: ServerCore) {
  const { db, bb } = ctx;
  const kv = bb.storage.kv;

  async function firstRun(projectId: string) {
    const draft = ((await kv.get(draftKey(projectId))) as FirstRunDraft | undefined) ?? { projectId, answers: {}, at: Date.now() };
    return { needed: firstRunNeeded(loadProjectSettings(db, projectId), draft), steps: FIRST_RUN_STEPS, draft };
  }
  async function firstRunAnswer(projectId: string, step: FirstRunStep, answer: string) {
    const draft = answerFirstRun((await firstRun(projectId)).draft, step, answer);
    await kv.set(draftKey(projectId), draft as never);
    ctx.log(`INFO first-run answered project=${projectId} step=${step}`);
    return draft;
  }
  /** The one profile writer: the finished draft becomes the project's settings here and nowhere else. */
  async function firstRunFinish(projectId: string) {
    const { draft } = await firstRun(projectId);
    const settings = firstRunSettings(draft);
    for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, projectId, key, value);
    if (draft.answers.goal) saveProjectSetting(db, projectId, "project.goal", draft.answers.goal);
    await kv.set(draftKey(projectId), { ...draft, done: Date.now() } as never);
    return { written: Object.keys(settings), goal: Boolean(draft.answers.goal) };
  }

  return { front: { firstRun, firstRunAnswer, firstRunFinish } };
}
export type FrontApi = ReturnType<typeof createFront>["front"];
