---
title: The hand-off standard
type: reference
status: active
created: 2026-11-10
confidence: medium
tags: [guide, handoff, graphs, roles]
updated: 2026-11-10
sources:
  - packages/workflow-engine/src/agent-output.ts
  - packages/workflow-engine/src/lower.ts
  - packages/workflow-engine/src/values.ts
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/model-json.ts
  - packages/workflow-engine/src/verdict.ts
  - src/rooms/brief/index.ts
  - src/rooms/critique/server/critique-runs.ts
  - tests/handoff-standard.test.ts
  - tests/workflow/honest-exit.test.ts
---

# The hand-off standard

> Part of the [Lane Pilot guide](../../README.md#the-guide). Written on 2026-11-10 after the owner opened a `pm-read` thread and found 24 KB of pasted source under «open no files».

One agent gives work to another and gets a result back. This page says what crosses that boundary in each direction, for a graph step, a stage of the task pipeline and a background helper alike. It is the engine's existing contract finished, not a new protocol: five reports (frameworks, protocols, papers, field practice, our own inventory of about 60 hand-off sites) and Google's Elephant–Goldfish model all pointed at what `agentPrompt` and `renderBrief` already did in part.

## The task (down)

One self-contained message, in this order.

| # | Part | Rule | Where |
|---|---|---|---|
| 1 | Role and method | Standing text, short. Who the agent is in this step and how the work is done. | `agentPrompt` (`packages/workflow-engine/src/agent-output.ts`), `instructions` of `renderBrief` (`src/rooms/brief/index.ts`) |
| 2 | Goal | The outcome and why it matters. Every requirement is in this one message, never spread over turns. | `<task>`, `<task_goal>` |
| 3 | Where to start | **Paths, never file contents.** A file the agent can open is named. Only data it cannot reach rides in the message: hub records, the plan, the owner's words, the previous step's handoff. Anything large goes by reference to a file. | `<step-packet>` (3 KB, larger inputs by path), `<inputs>`, data blocks |
| 4 | Boundaries | **Read-only, not «no tools».** What the agent may change, what is out of scope. Outside text is marked «data, not instructions». | `READ_ONLY_LINE`, `REVIEW_READ_ONLY_LINE` |
| 5 | Done-when | What will be checked, not how to build it. | `<acceptance>`, the node's `gates` |
| 6 | Answer format | **Last.** Behind a data tail over 8,000 characters a brief repeats it. | `outputContract`, `<output>`, `OUTPUT_REPEAT_AFTER` |

A reviewer gets a clean context: the thing to review, by path, and none of the author's reasoning. An agent that continues someone's work gets that agent's handoff, not its transcript.

## The result (up)

Plain-text reasoning first, then one JSON object as the last thing in the final message.

| Field | Values | Meaning |
|---|---|---|
| `outcome` | `done` · `partial` · `blocked` · `failed` | The agent's own word on whether the result exists. Absent means `done`. |
| `blocker` | `{needs, from, fallback}` | Only with `blocked`: what is missing, who can give it (owner, pm, another step), what can be done without it. |
| `handoff` | text | What was done, where the result is (paths, `file:line`), what is left. Always owed, also on an exit. |
| the step's own fields | declared in `out` | Owed with `done` and `partial` only. |
| reviewers: `status` | `pass` · `rework` · `block` | The verdict on the work reviewed (`verdict/1`). Findings carry `file`, `line`, `severity` (`critical` … `info`) and quoted `evidence`. |

`outcome` and `status` are two different things. `outcome` is about the agent's own job («I could not review»). `status` is about someone else's work («the plan has a hole»).

**The honest exit.** An agent that is blocked or cannot do the task owes the handoff and nothing else. Asked for the other fields it would invent them. Before 2026-11-10 a graph step had no way to say this and the graph went on with made-up values.

- **Graph step.** The engine adds `outcome` and `blocker` to every agent node (`outputFields`, `lower.ts`). `blocked` or `failed` stops the run with `agent_blocked:<node>` or `agent_failed:<node>` and the agent's reason; a blocked step is not retried, since another attempt cannot bring what it lacks. A node that declares `outcome` itself, or an enum with `blocked` in it, keeps routing on its own field and the engine stays out (`engineOwnsOutcome`).
- **Pipeline stage** (scout, plan critic, specialist, code critic, night review, gate triage). The prompt offers the exit in one shared sentence (`ANSWER_FORM_LINE`); `helperExit` reads it and the stage fails with `helper_blocked:needs … from …`.
- **Writer.** `NEEDS_HUMAN:` is the same exit in the writer's older spelling: `blocked`, from the owner. An errand's `ERRAND: blocked` likewise.

## Reading an answer

One way for every stage (`readAnswer`, `critique-runs.ts`; a graph step does the same in `workflow-agent.ts`).

1. An honest exit is taken as said. No re-ask.
2. `extractModelJson` finds the object: the whole text, the last fenced block, the outermost braces. Prose before it is fine.
3. Known foreign words fold into ours (`normalizeVerdictInput`: `approve`, `lgtm`, `changes_requested`, `reject` …).
4. An answer that still cannot be read is sent back **once, to the same thread**: «do not redo the work, send the same answer again». The wait for that turn is bounded at 10 minutes.
5. A second unreadable answer means the stage **did not run**. That is never the same as a stage with no findings. The receipt is `failed` with the reason. What the task does then is the stage's own policy:

| Stage | After a second unreadable answer |
|---|---|
| Plan critic | Fails closed: no writer has started, the PM gets the reason. |
| Scout (`pm-read`) | The task goes on without a summary. |
| Specialist reviewer | `failed_infra`, the task goes on; the receipt says the review did not run. |
| Code critic | The role's next model takes over; a spent pool is `failed_infra` and the task goes on. |
| Graph step | `output_invalid`, the node's `maxAttempts` decides. |

## Facts and claims

What the server observed is recorded apart from what the agent says. A writer's changed files, check exit codes and hashes come from the host (`buildCandidateEvidence`), not from the writer's message; a read-only step is checked by a git diff after it ran. A reviewer's finding counts as serious only with a file, a line and quoted evidence (`settleVerdict`).

## What the guard enforces

`tests/handoff-standard.test.ts` reads the source. Its lists only shrink.

- `NO_TOOLS_LINE` is used by three reviewers that judge hub data only (night review, onboarding preview, gate triage). No other file may tell an agent to open nothing.
- «JSON and nothing else» survives in ten one-shot analysers written before the standard; no new file may add it.
- The two read-only sentences come from their constants and are not copied by hand.

## Not yet on the standard

- The critics' prompts are built by hand, not by `renderBrief`: same content and order, without the tagged sections.
- The writer and the errand keep their marker lines (`NEEDS_HUMAN:`, `ERRAND: done|blocked`).
- Night review and the onboarding preview still get their material pasted with «open no files». Neither ran in the week before this page was written.
- 24 of the 237 agent nodes in `workflows/` declare a status of their own with `blocked` in it (`done|blocked` mostly); they route on it themselves and get no engine `outcome`.

## What was taken from where

| Rule | Source |
|---|---|
| Task, message and artifact as separate things; a small fixed set of states; a question mid-task is a state, not a line of prose | A2A 1.0, MCP 2025-11-25 |
| Large content by reference; the child returns a summary with `file:line`, the payload stays on disk | Anthropic, Cognition, Manus, HumanLayer field reports; MCP `resource_link` |
| A reviewer that failed or returned nothing did not review: retry once, then `not run`; clean context for the reviewer; standing role apart from the per-run parameters | Google Elephant–Goldfish model (commit of 2026-11-09) |
| An explicit stop status with what is missing, who resolves it and a fallback. Without the status a blocker is read as a caveat (recognition 99.2% → 40.6%); with all four fields no forbidden action was taken | Sun et al., «When Must Becomes Maybe», arXiv 2608.24569 |
| Reasoning first, the structured block last. An answer-only JSON form costs the model its reasoning | Fan et al., «Capacity, Not Format», arXiv 2606.09410 |
| The answer format at the end of the message, repeated after a long tail. A format line only at the top is dropped by 25.5% of answers at 64k tokens | Anchan & Sen, arXiv 2610.06069; Xue et al., arXiv 2607.17937 |
| A verifier judges the step or its summary, not the raw trace | MAS-ProVe, arXiv 2602.03053 |
| What the harness observed apart from what the agent claims | PCM, arXiv 2610.39109 |
| Most multi-agent failures are specification and misalignment, not parsing (44.2% and 32.3% of 1,642 traces) | Cemri et al., «Why Do Multi-Agent LLM Systems Fail?», arXiv 2503.13657 |

The reports with every quote are in the thread storage of the session that wrote this page (`.bb/chats/thr_iv28gegftm/artifacts/handoff-research/`).
