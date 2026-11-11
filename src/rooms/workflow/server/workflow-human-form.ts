import { str } from "./workflow-chain-runtime";
import type { Row } from "./workflow-chain-runtime";
import { bestEffort } from "@lane-pilot/kit";
import { outputContract } from "@lane-pilot/workflow-engine";
import type { Field, GraphNode, NodeExecutor, PollResult, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { postOwnerItem } from "../../owner-waiting";
import { BUILTIN_PRESETS } from "@lane-pilot/models";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import { ownerLocale, workflowHumanDetail } from "../../relay/server";
import type { WorkflowAgents } from "./workflow-agent";

/** The line of the owner's list a question of a run with no PM chat is (answered with `workflow_answer`, which closes it). */
export const workflowQuestionKey = (runId: string, stepKey: string) => `workflow-question:${runId}:${stepKey}`;

// ---------------------------------------------------------------- the owner's question

/** The enum values that carry words, not a decision: a free answer may stand for one of them, never for approve/deploy/send/proceed. */
const TEXT_KINDS = ["text", "answered", "provide", "given", "reason", "chosen", "resolved"];

/** What the form offers: the values of the node's `answer_kind` that a person can pick (not the clock's `timeout`, not the skip markers). */
export function humanOptions(node: Extract<GraphNode, { type: "human" }>): string[] {
  const kind = node.out.find((field) => field.name === "answer_kind");
  return (kind?.values ?? node.options).filter((value) => !["timeout", "none", "given"].includes(value));
}

const normalizeChoice = (text: string) => text.toLowerCase().replace(/[_\-\s]+/g, " ").replace(/^[\s.,;:!?'"«»()]+|[\s.,;:!?'"«»()]+$/g, "");

/** The 1-based option a typed answer names outright (the option's own words, or its number); never a guess from the wording around it. */
function namedOption(options: string[], text: string): number | null {
  const said = normalizeChoice(text);
  if (!said) return null;
  const byName = options.findIndex((value) => normalizeChoice(value) === said);
  if (byName >= 0) return byName + 1;
  const byNumber = /^(?:option|choice|вариант|№|#)?\s*(\d{1,2})$/.exec(said);
  const number = byNumber ? Number(byNumber[1]) : 0;
  return number >= 1 && number <= options.length ? number : null;
}

/** The node's output with `answer_kind` set to `kind` and the words as `answer`; the other fields empty. */
export function humanFields(node: Extract<GraphNode, { type: "human" }>, kind: string | undefined, text: string): Row {
  const out: Row = {};
  for (const field of node.out) {
    if (field.name === "answer_kind") { if (kind !== undefined) out.answer_kind = kind; continue; }
    if (field.name === "answer") { out.answer = text; continue; }
    out[field.name] = field.type === "array" ? (text && node.out.filter((other) => other.type === "array").length === 1 ? [{ answer: text }] : []) : field.type === "number" ? 0 : field.type === "boolean" ? false : field.type === "object" ? {} : field.type === "enum" ? field.values![0] : "";
  }
  return out;
}

/**
 * The node's output from the owner's answer: the chosen value as `answer_kind`, the words as `answer`, the other fields empty.
 * Words alone make a choice only when they name an option; otherwise they are a text answer if the node has a text kind.
 * Null when the answer decides nothing (an approval answered with a remark): the step keeps waiting and the owner is asked again.
 */
export function humanOutput(node: Extract<GraphNode, { type: "human" }>, answer: { choiceIndex: number | null; text: string }): Row | null {
  const options = humanOptions(node);
  const values = node.out.find((field) => field.name === "answer_kind")?.values ?? [];
  const index = answer.choiceIndex ?? (answer.text ? namedOption(options, answer.text) : null);
  // «Decide yourself» hands the choice back: the step's default option is the machine's answer.
  const delegated = index === null && node.defaultOption && DELEGATE.test(answer.text.trim()) ? options.indexOf(node.defaultOption) + 1 || null : null;
  const chosen = (index ?? delegated) !== null ? options[(index ?? delegated)! - 1] : undefined;
  if (chosen !== undefined) return humanFields(node, chosen, answer.text);
  if (!answer.text) return options.length ? null : humanFields(node, undefined, "");
  const kind = TEXT_KINDS.find((value) => values.includes(value));
  return kind !== undefined || !values.length ? humanFields(node, kind, answer.text) : null;
}

/** Words that hand the decision back to the machine. */
const DELEGATE = /^(сам[аи]? реша[йи]|реша[йи] сам[аи]?|на (тво[её]|ваше) усмотрение|как (считаешь|хочешь|лучше)|выбери сам|decide (yourself|for me)|your call|up to you|whatever you think)[.!]?$/iu;

/** The longest a human step of a machine-started run waits for the owner's answer. */
export const MACHINE_HUMAN_WAIT_SEC = 15 * 60;
/** Whether the machine started the run (or the run it is a subworkflow of): keys `intake:` and `phase:`. */
export function machineStarted(engine: WorkflowEngine, runId: string): boolean {
  let row = engine.journal.getRun(runId);
  for (let hop = 0; row && hop < 8; hop += 1) {
    if (row.idem_key?.startsWith("intake:") || row.idem_key?.startsWith("phase:")) return true;
    row = row.parent_run_id ? engine.journal.getRun(row.parent_run_id) : undefined;
  }
  return false;
}

/** Whether the run (or the run it is a subworkflow of) is work the lead handed over: intake key `intake:<pm thread>:lead:<road>`. */
export function leadHanded(engine: WorkflowEngine, runId: string): boolean {
  let row = engine.journal.getRun(runId);
  for (let hop = 0; row && hop < 8; hop += 1) {
    if (/^intake:[^:]+:lead:/.test(row.idem_key ?? "")) return true;
    row = row.parent_run_id ? engine.journal.getRun(row.parent_run_id) : undefined;
  }
  return false;
}

/** The `builtin:human` executor: the owner's question as a BB form, or a line of the owner's list when the run has no PM chat. */
export function registerHumanForm(engine: WorkflowEngine, ctx: ServerCore, agents: WorkflowAgents, deps: {
  runtimeOf: (c: { runtime: unknown }, runId?: string) => ChainRuntime | undefined;
}): void {
  const { bb, db } = ctx;
  const { runtimeOf } = deps;

  // ---------------------------------------------------------------- human: the owner's question as a BB form
  const openForms = new Set<string>();
  const composing = new Map<string, Promise<string>>();
  /**
   * A human step's text is an instruction to whoever asks («Show the findings and offer revise, proceed, abort»), in English. Shown as
   * it is, the owner got the instruction instead of the question, with no findings in it (live 2026-10-25). A cheap helper writes the
   * question from it and the run's results so far, in the owner's language; when it fails the instruction is shown as before.
   */
  const composeQuestion = (rt: ChainRuntime, runId: string, stepKey: string, node: Extract<GraphNode, { type: "human" }>, instruction: string): Promise<string> => {
    const key = `${runId}|${stepKey}`;
    const known = composing.get(key);
    if (known) return known;
    const job = (async () => {
      const locale = await bestEffort(rt.ctx.log, "workflow owner locale", ownerLocale(rt.ctx.bb), "ru");
      const results = engine.journal.steps(runId).filter((step) => step.state === "succeeded" && step.output_json && step.output_json !== "{}").slice(-6)
        .map((step) => `${step.node_id}: ${step.output_json!.slice(0, 1500)}`).join("\n");
      const options = humanOptions(node).map((value) => value.replace(/_/g, " "));
      const fields: Field[] = [{ name: "question", type: "string", required: true }];
      const preset = BUILTIN_PRESETS["cheap-fast"]!;
      const result = await agents.run({
        rt, workflowRunId: runId, stepKey, nodeId: node.id, spawnKey: `${stepKey}:question`, role: "analyst", title: `question for the owner: ${node.id}`, fields,
        provider: preset.providerId, model: preset.model, reasoning: preset.reasoning ?? "low",
        prompt: [`Write the question the owner sees in a form, in ${locale === "ru" ? "Russian" : "English"}, from the step's instruction and the run's results so far. Plain words, no ids, no JSON, no English terms the owner would not know; say briefly what happened, what is being decided and what each option leads to.${options.length ? ` The form shows these buttons as they are: ${options.join(", ")}; name them the same way.` : ""} At most 900 characters. Read nothing else and change nothing.`,
          `Instruction: ${instruction}`, `Results so far:\n${results || "(none)"}`, outputContract(fields)].join("\n\n"),
      });
      const text = str(result.output.question).trim();
      return text || instruction;
    })().catch((cause: unknown) => { bb.log.warn(`Lane Pilot could not word the question of ${node.id} (${cause instanceof Error ? cause.message : String(cause)}); the instruction is shown`); return instruction; });
    composing.set(key, job);
    return job;
  };
  const ask = async (rt: ChainRuntime, runId: string, stepKey: string, node: Extract<GraphNode, { type: "human" }>, question: string, deadline?: number, base: string = question): Promise<void> => {
    const key = `${runId}|${stepKey}`;
    if (openForms.has(key)) return;
    // No PM chat to show a form in: the question is a line of the owner's list, with a push, answered by `workflow-answer` or its button.
    if (!rt.pmThreadId) {
      const options = humanOptions(node);
      const workflowId = engine.journal.getRun(runId)?.workflow_id ?? "a workflow";
      postOwnerItem(db, {
        key: workflowQuestionKey(runId, stepKey), source: "workflow", kind: "workflow_question", projectId: rt.projectId, wake: true,
        what: `Процесс «${workflowId}» спрашивает: ${base}`,
        why: `Процесс стоит, пока нет ответа.${options.length ? ` Варианты: ${options.map((value) => value.replace(/_/g, " ")).join(" / ")}.` : ""}${node.timeoutSec ? " Если не ответить, шаг решит сам, когда выйдет его время." : ""}`,
        evidence: [{ kind: "run", ref: runId, label: node.id }, { kind: "command", ref: `bb lane-pilot workflow-answer ${runId} ${stepKey} <${options.length ? "option" : "words"}> [words]` }],
        actions: options.map((value) => ({ id: value, label: value.replace(/_/g, " "), cli: `bb lane-pilot workflow-answer ${runId} ${stepKey} ${value}`, rpc: { method: "workflow_answer", input: { runId, stepKey, choice: value } } })),
      });
      openForms.add(key);
      return;
    }
    const worded = await composeQuestion(rt, runId, stepKey, node, base);
    if (openForms.has(key)) return;
    const options = humanOptions(node);
    // An answer can come before the form is reported shown: the form is then not marked open, or the re-ask would think it still is.
    let answered = false;
    const shown = await rt.ctx.ownerAsk.askInBackground(rt.pmThreadId, { source: "pm", kind: "decision", question: question === base ? worded : `${question.slice(0, question.length - base.length)}${worded}`, detail: workflowHumanDetail(await ownerLocale(rt.ctx.bb), runId, node.id), options: options.map((value) => value.replace(/_/g, " ")) },
      async (answer) => {
        answered = true;
        openForms.delete(key);
        if (answer.outcome === "answered") {
          const output = humanOutput(node, { choiceIndex: answer.choice ? Number(answer.choice.id) : null, text: answer.text });
          // Words that name no option and fit no text kind decide nothing: the step keeps waiting and the owner is asked again, with the options listed.
          // The notice goes before the step's own question once, not once per wrong answer (it stacked up, live 2026-10-25).
          const listed = options.map((value) => value.replace(/_/g, " ")).join(" / ");
          if (!output) { await ask(rt, runId, stepKey, node, `${(await bestEffort(rt.ctx.log, "workflow owner locale", ownerLocale(rt.ctx.bb), "ru")) === "ru" ? `Ответ не выбрал вариант (${listed}).` : `Your answer did not choose an option (${listed}).`} ${base}`, deadline, base); return; }
          // The form opens while the step is being recorded as waiting: an answer that arrives first is retried until the step can take it.
          for (let tries = 0; tries < 50; tries += 1) {
            if (await engine.resolve(runId, stepKey, output)) return;
            const state = engine.journal.getStep(runId, stepKey)?.state;
            if (state !== "running" && state !== "waiting" && state !== "pending") return;
            if (state !== "waiting") await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        // A dismissed or timed-out form leaves the step waiting: the next poll asks again, or the step's own timeout answers it.
      }, { timeoutMs: deadline ? Math.max(1000, deadline - Date.now()) : undefined });
    if (shown && !answered) openForms.add(key);
  };
  engine.register<ChainRuntime>("builtin:human", {
    run: async (c) => {
      const node = c.node as Extract<GraphNode, { type: "human" }>;
      const question = c.render(node.question);
      // A run the machine started (the intake's small-task graph, a phase's stage) does not stand for the owner (he takes no part in the
      // loop): the form is still shown, but the step's own timeout answers it after MACHINE_HUMAN_WAIT_SEC at most.
      const timeoutSec = machineStarted(engine, c.runId) ? Math.min(node.timeoutSec ?? MACHINE_HUMAN_WAIT_SEC, MACHINE_HUMAN_WAIT_SEC) : node.timeoutSec;
      const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : undefined;
      const rt = runtimeOf(c, c.runId);
      if (rt) void ask(rt, c.runId, c.stepKey, node, question, deadline).catch((cause) => bb.log.warn(`Lane Pilot could not ask the owner (${node.id}): ${cause instanceof Error ? cause.message : String(cause)}`));
      return { wait: { kind: "human", detail: { question, options: humanOptions(node) }, ...(deadline ? { deadline } : {}) } };
    },
    poll: async (step, { node, runtime }): Promise<PollResult> => {
      const human = node as Extract<GraphNode, { type: "human" }>;
      if (step.await.deadline && Date.now() >= step.await.deadline) {
        // A question whose answer kinds include `timeout` is answered by the clock; otherwise onTimeout says.
        const kind = human.out.find((field) => field.name === "answer_kind");
        if (kind?.values?.includes("timeout")) return { output: humanFields(human, "timeout", "") };
        if (human.onTimeout === "default" && human.defaultOption) {
          const field = human.out.find((candidate) => candidate.type === "string" || candidate.type === "enum");
          return { output: field ? { [field.name]: human.defaultOption } : {} };
        }
        return { error: "human_timeout" };
      }
      // After a reload the form is gone with the old instance: ask again.
      const rt = runtimeOf({ runtime }, step.runId);
      const detail = step.await.detail as { question?: string } | undefined;
      if (rt && detail?.question) await ask(rt, step.runId, step.stepKey, human, detail.question, step.await.deadline);
      return null;
    },
  } as NodeExecutor<ChainRuntime>);
}
