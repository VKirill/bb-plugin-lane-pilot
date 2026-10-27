import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { runGraphHelper } from "../../workflow/server";
import type { ChainRuntime } from "../../workflow/server";
import type { ServerCore, Services } from "../../core/server";

/**
 * The wall's hunt as a graph (workflows/lp.wall-hunt.json): the read-only hunters side by side (one step per angle: task, system, big picture), then
 * `judge` (code: their citations are held against the evidence pack and the findings are written to the wall row), then `analysis` (one strong
 * reader, only when the run was asked for it) and `record` (the analysis goes into the wall row). The planning stays in the wall room: the night's
 * selection and `advance` decide which wall is hunted and start the graph through the wall's port; the hunter's model is the wall's setting
 * (`wall.hunter_*`). A hunter that fails is a hunter with no finding; the run fails only when none of them, or the analysis, gave anything, and
 * only after the wall row holds what there was.
 */
const READER_WAIT_MS = 25 * 60_000;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null) : []);
/** A reader thread that reports no usage still cost something: its prompt and answer, read a few times. */
const estimateTokens = (...texts: string[]): number => Math.ceil(texts.reduce((sum, part) => sum + part.length, 0) / 3) * 3;

export function mountWallHuntGraph(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  const wall = services.wall;
  const stopped = (c: StepContext<ChainRuntime>): boolean => ctx.isDisposed() || c.signal.aborted;

  /** One reader as a step: the thread, its answer, what it cost. Its failure is data (`ok: false`), not an error, unless the plugin is going away. */
  async function reader(c: StepContext<ChainRuntime>, who: "hunter" | "analysis", label: string, prompt: string) {
    try {
      const run = await runGraphHelper(ctx, c, {
        key: `${who}:${label}`, label: "wall_reader_timeout", waitMs: READER_WAIT_MS, projectId: c.runtime?.projectId ?? null, archive: true,
        spawn: (graph) => wall.graph.spawnReader({ who, prompt, graph }),
      });
      const answer = run.text.trim();
      const spent = run.usage.usage && !run.usage.usage.unknown ? run.usage.usage.tokens : null;
      return { output: { angle: label, ok: answer !== "", text: answer, tokens: spent ?? estimateTokens(prompt, answer), error: "", handoff: answer ? `${label} answered` : `${label} gave an empty answer` }, ...run.usage };
    } catch (cause) {
      if (stopped(c)) throw cause;
      const error = cause instanceof Error ? cause.message : String(cause);
      return { output: { angle: label, ok: false, text: "", tokens: estimateTokens(prompt), error, handoff: `${label} failed: ${error}`.slice(0, 300) } };
    }
  }

  engine.register<ChainRuntime>("lp.wall-hunter", {
    // The spawn is a journal effect keyed by the angle: a step a reload cut off reads the thread it already made.
    reentrant: true,
    run: async (c) => {
      const angle = text(c.input.item);
      return reader(c, "hunter", angle, wall.graph.hunterPrompt(angle, c.resolve("$inputs.pack") as never));
    },
  } as NodeExecutor<ChainRuntime>);

  // The join hands the hunters' rows on in the order of the angles.
  engine.register<ChainRuntime>("reduce.lp.wall-hunt.hunters", {
    reentrant: true,
    run: async (c) => ({ output: { hunters: list(c.input.with.results) } }),
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.wall_judge", {
    reentrant: true,
    run: async (c) => {
      const rows = list(c.resolve("hunt.hunters"));
      if (rows.length === 0) return { output: { state: "none", tokens: 0, outcome: {}, handoff: "no hunters asked" } };
      const judged = wall.graph.judge(text(c.resolve("$inputs.wall_key")), c.resolve("$inputs.pack") as never, rows.map((row) => ({ angle: text(row.angle), text: row.ok === true ? text(row.text) : null, tokens: Number(row.tokens) || 0 })));
      return { output: { state: judged.outcome.state, tokens: judged.tokens, outcome: judged.outcome, handoff: `hunt ${judged.outcome.state}: ${judged.outcome.usable.length} usable` } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.wall-analyst", {
    reentrant: true,
    run: async (c) => {
      const prompt = text(c.resolve("$inputs.analysis_prompt"));
      if (!prompt) return { output: { angle: "", ok: true, text: "", tokens: 0, error: "", handoff: "no analysis asked" } };
      return reader(c, "analysis", "analysis", prompt);
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.wall_record", {
    reentrant: true,
    run: async (c) => {
      const hunters = list(c.resolve("hunt.hunters"));
      const asked = text(c.resolve("$inputs.analysis_prompt")) !== "";
      const problems: string[] = [];
      if (asked) {
        if (c.resolve("analysis.ok") === true) wall.graph.recordAnalysis(text(c.resolve("$inputs.wall_key")), text(c.resolve("analysis.text")));
        else problems.push(`the analysis gave nothing: ${text(c.resolve("analysis.error")) || "empty answer"}`);
      }
      if (hunters.length > 0 && !hunters.some((row) => row.ok === true)) problems.push(`no hunter gave an answer: ${text(hunters[0]?.error) || "empty answers"}`);
      // The wall row holds what there was; a run in which nothing came back is a failed run, which the wall sees.
      if (problems.length) throw new Error(`wall_hunt_failed: ${problems.join("; ")}`);
      return { output: { recorded: true, handoff: "recorded" } };
    },
  } as NodeExecutor<ChainRuntime>);
}
