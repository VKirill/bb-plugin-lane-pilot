import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/database";
import type { OwnerMessage } from "../../src/rooms/anamnesis/owner-messages";
import type { JevClient } from "@lane-pilot/jev";
import { createJev } from "@lane-pilot/jev";
import type { JevAnswer, JevQuestion } from "@lane-pilot/jev";
import { DEFAULT_CONFIG, type LearningConfig } from "../../src/rooms/learning/config";
import { MESSAGE_KIND_NAMES } from "../../src/rooms/learning/judgment";

export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
export const database = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);

let counter = 0;
export const message = (text: string, over: Partial<OwnerMessage> = {}): OwnerMessage =>
  ({ id: `thr_a:${++counter}:0`, threadId: "thr_a", projectId: "proj_1", at: NOW - 60_000, text, ...over });

export const config = (over: Partial<LearningConfig> = {}): LearningConfig => ({ ...DEFAULT_CONFIG, ...over });

/** What a scripted Jev says about a message: the share of each message kind, worth remembering, the date question, annoyance. */
export type Script = { kind?: [string, number]; durable?: number; deadline?: number; level2?: number; level1?: number; scope?: string; relations?: Array<"same" | "opposite" | "different"> };

export function kindProbabilities(top: string, p: number): Record<string, number> {
  // The rest of the mass goes to a kind that teaches nothing, so a test states exactly how sure Jev is.
  const rest = top === "task" ? "question" : "task";
  return Object.fromEntries([...MESSAGE_KIND_NAMES.map((name) => [name, 0]), [top, p], [rest, 1 - p]]);
}

/** A Jev client that answers every message by the first keyword rule that matches its text. */
export function scriptedClient(rules: Array<[RegExp, Script]>, options: { fail?: boolean } = {}) {
  const calls: Array<{ state: Record<string, string>; ids: string[] }> = [];
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      const state = request.state as Record<string, string>;
      calls.push({ state, ids: Object.keys(request.questions) });
      if (options.fail) return { ok: false, status: "error", error: "boom", latencyMs: 5, attempts: 1 };
      const script = rules.find(([pattern]) => pattern.test(state.owner_message ?? state.new_statement ?? state.situation ?? ""))?.[1] ?? {};
      const answerFor = (full: string, question: JevQuestion): JevAnswer => {
        const id = full.replace(/^\d+::/, "");
        if (id === "kind") {
          const probabilities = kindProbabilities(script.kind?.[0] ?? "task", script.kind?.[1] ?? 0.9);
          const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
          return { type: "choice", choice: top, probabilities, confidence: 0.8 };
        }
        if (id === "scope") return { type: "choice", choice: script.scope ?? "task", probabilities: { [script.scope ?? "task"]: 0.8, task: 0.2 }, confidence: 0.7 };
        if (id === "durable") return { type: "noul", noul: script.durable ?? 0.1 };
        if (id === "deadline") return { type: "noul", noul: script.deadline ?? 0.02 };
        if (id === "frustration") return { type: "score", score: 0, legend: {}, probabilities: { "0": 1 - (script.level2 ?? 0) - (script.level1 ?? 0), "1": script.level1 ?? 0, "2": script.level2 ?? 0 }, confidence: 0.9 };
        const relation = /^r(\d+)$/.exec(id) ? script.relations?.[Number(id.slice(1)) - 1] ?? "different" : null;
        if (relation) return { type: "choice", choice: relation, probabilities: { [relation]: 0.9, different: 0.1 }, confidence: 0.9 };
        return question.type === "noul" ? { type: "noul", noul: 0.5 } : { type: "choice", choice: "different", probabilities: { different: 1 }, confidence: 1 };
      };
      return { ok: true, model: "jev-test", usage: { input_tokens: 700, output_tokens: 20 }, latencyMs: 30, attempts: 1,
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answerFor(id, question)])) };
    },
  };
  return { client, calls };
}

export const jevWith = (db: ReturnType<typeof database>, rules: Array<[RegExp, Script]>, options: { fail?: boolean } = {}) => {
  const scripted = scriptedClient(rules, options);
  return { jev: createJev({ client: scripted.client, db }), calls: scripted.calls };
};
