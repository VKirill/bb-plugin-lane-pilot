import { describe, expect, it } from "vitest";
import { intakeByRules, intakeJudgment } from "../../src/rooms/phase/intake";

describe("a batch label", () => {
  it("[sma:m_ce_batch] the words «make a batch» are not a batch by themselves; a judgment that says batch is kept", () => {
    expect(intakeByRules("make a batch")).toEqual({ kind: "small", confident: false });
    const decided = intakeJudgment.decide(
      { weight: { type: "choice", probabilities: { batch: 0.9, small: 0.05, reply: 0.05 } } } as never,
      { min_p: 0.55 },
      { text: "make a batch" },
    );
    expect(decided.decision?.kind).toBe("batch");
  });

  it.todo("[sma:m_ce_batch] a batch label does not become pieces in a named lane"); // deferral:dfr_seed_skip_sma_gaps
});

describe("conversation assembly the proofs name and the code does not do", () => {
  it.todo("[sma:m_cd_assemble] window and Telegram do not share one assembly of project, board, voice account and phase discussion"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_dispatch] a free turn is not booked with no seat, copy or receipt under its own spend id"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_voice] there is no orchestrator account and no daytime owner among workers"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_ensure] an impostor is not lifted out of the worker list into a role block"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_prompt] the PM profile does not carry voice, board, task snapshot, memory and the discussion rubric"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_observe] the task board is not exactly one observation of a git action or of this door"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_seed] the orchestrator profile is not laid into the session before launch"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_sg_clarify] nothing reads a task tree, proposes clarification items, and writes nothing"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_sg_breakdown] a phrase is not compared with backlog lines, and no question is asked from that"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_sg_batch_draft] plan() stores the items it is given; a phrase is not split into pieces, links and a lane"); // deferral:dfr_seed_skip_sma_gaps
});
