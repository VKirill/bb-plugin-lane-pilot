import type { Room } from "../../contracts";
import type { FrontApi } from "./services/first-run";

export const room: Room<{ front: FrontApi }> = {
  name: "front",
  rpc: (_ctx, services) => ({
    first_run_get: async ({ projectId }: { projectId: string }) => services.front.firstRun(projectId),
    first_run_answer: async ({ projectId, step, answer }: { projectId: string; step: "goal" | "writer" | "quality" | "words"; answer: string }) => services.front.firstRunAnswer(projectId, step, answer),
    first_run_finish: async ({ projectId }: { projectId: string }) => services.front.firstRunFinish(projectId),
  }),
};
