const BARRIER_DIFF_CAP = 200_000;
/** What the barrier judged, archived per attempt (sma av_inputs): diff, promise, contract, the previous verdict and the receipt hash. */
export function barrierInputBody(input: { state: "passed" | "blocked" | "skipped"; inputSha256: string | null; diff: unknown; promise: unknown; contract: unknown; priorVerdict: unknown }): Record<string, unknown> {
  // A patch over the cap is cut and says so: the inputSha256 still names exactly what was judged.
  const text = input.diff == null ? null : typeof input.diff === "string" ? input.diff : JSON.stringify(input.diff);
  const diff = text !== null && text.length > BARRIER_DIFF_CAP ? `${text.slice(0, BARRIER_DIFF_CAP)} [cut: ${text.length - BARRIER_DIFF_CAP} chars]` : input.diff ?? null;
  return { stage: "code-critique", state: input.state, inputSha256: input.inputSha256, diff,
    promise: input.promise ?? null, contract: input.contract ?? null, priorVerdict: input.priorVerdict ?? null };
}
