// The subject the mutation runner's fixture mutates (tests/sma-mutate.test.ts): a verdict with a branch, a field and a target.
export type Verdict = { status: "pass" | "rework"; score: number; target: string };

export function judge(score: number, target: string): Verdict {
  if (score >= 7) return { status: "pass", score, target };
  return { status: "rework", score, target };
}
