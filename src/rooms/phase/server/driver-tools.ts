import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import type { PhaseReactions } from "./reactions";

export class PhaseRefusal extends Error {
  constructor(message: string, readonly why: string[] = []) { super(message); }
}

/** A stage's name in the owner's words (the rows on «Ждут владельца» and the wall's subject). */
export const STAGE_RU: Record<string, string> = { discussion: "обсуждение", planning: "планирование", design: "проектирование", execution: "исполнение", lessons: "уроки" };

/**
 * What every piece of the phase driver starts from: the core, the services bag, the phase's own clock and the reactions
 * handed in by the composition root. Each installer takes this plus exactly the pieces installed before it, so a wrong
 * install order is a type error — there is no shared bag to assign into.
 */
export type DriverBase = {
  ctx: ServerCore;
  services: Services;
  db: ServerCore["db"];
  bb: ServerCore["bb"];
  now: () => number;
  reactions: PhaseReactions;
};
