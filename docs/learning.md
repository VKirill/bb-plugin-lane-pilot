---
title: Learning from the owner's messages
type: component
created: 2026-10-08
updated: 2026-11-13
status: active
confidence: medium
tags: [learning, rules, owner-messages, lessons, nightly]
sources:
  - src/rooms/anamnesis/owner-messages.ts
  - src/rooms/learning/observe.ts
  - src/rooms/learning/extract.ts
  - src/rooms/learning/decide.ts
  - src/rooms/learning/autonomy.ts
  - packages/run-insights/src/lessons.ts
  - src/rooms/self-repair/server/insights.ts
  - src/rooms/learning/migrations.ts
  - src/rooms/learning/store.ts
---

# Learning from the owner's messages

Design of 2026-10-08 (T1-T8), reworked 2026-11-13 to use no Jev and no outside classifier. Code in `src/rooms/learning`. The owner's own
messages to his agents are collected as they are said; one night run reads the day's messages with a model and what teaches something
becomes a rule, a decision, a preference or a reminder, with the message it came from.

```
owner message (a person's request in a visible top-level thread: the one collector of src/rooms/anamnesis/owner-messages.ts)
  -> live feed (thread.active / thread.idle / experimental_thread.events -> read the new client/turn/requested)
  -> observer, a rule-based pre-filter (observe.ts, no model):
       machine text (isMachineMessage of phase/intake.ts)  -> skipped «machine»
       an acknowledgement or under 12 characters          -> skipped «short»
       over 12 000 characters (a pasted log)               -> skipped «pasted»
       over the day's cap                                  -> skipped «cap»
       sensitive words (health, family, money, ...)        -> recorded, no text kept, never read
       the rest                                            -> `candidate`: masked text + masked tail of the agent's reply
  -> night run (03:11, `learning-extract`): per project, all waiting candidates in batches of 25, one hidden model thread per batch
       the prompt lists what is in force (rules, learned items, the owner's global preferences) with ids k1..kN
       the model answers JSON per message: `nothing`, or one rule | preference | decision | deadline | fact, plus `same_as` / `contradicts`
        rule/preference, project   -> Lane Pilot rule on trial (audience pm|writer|both)
        rule/preference, owner     -> accepted by itself -> `bb memory add --scope global --kind preference`
        decision                   -> note in the project's memory
        date                       -> accepted by itself -> reminder in the thread
        fact                       -> recorded only (the anamnesis owns facts about the owner)
        same as one in force       -> confirmation; opposite -> replaces the old one, the new rule on trial
  -> afterwards what waited for a yes is accepted; daily 18:20: one report per project to the PM chat
```

## How it works

1. The collector hands the owner's messages of a visible top-level thread to the observer (`src/rooms/anamnesis/owner-messages.ts`).
2. The observer applies `prefilterReason` (machine text, short acknowledgement, pasted wall of text), the daily cap (`dailyCandidateCap`),
   masks personal data and stores the observation: `skipped` with the reason, or `candidate` with the masked text. A sensitive message keeps
   neither excerpt nor text (`src/rooms/learning/observe.ts`).
3. The night run (`nightRun` in `service.ts`, cron `11 3 * * *`) takes every project with waiting candidates and runs the extractor on
   batches of `nightBatch` messages until none is left or `nightRuns` runs are spent. The extractor model is the project's rules analyzer
   (the model the owner chose for rules); the same pass dedups against what is in force. `route` then chooses the item's state: `adopted`,
   `proposed`, `pending_owner`, `duplicate`, `dropped` or `noted` (`src/rooms/learning/extract.ts`).
4. Owner decisions settle the waiting items: `accept` stores the reminder or memory or adopts the rule; `reject` and `drop` end them
   (`src/rooms/learning/decide.ts`). The night run also accepts what waited for a yes, unless the project asks for the owner's word.
5. A read candidate is cleared of body text; a candidate unread after 36 hours turns `ignored` with reason `unread`.
6. Rules for the PM are picked for a text by rule, with no model: `relevantPmRules` keeps a rule marked `always`, a general rule (too few
   distinctive words) and any rule that shares a word stem with the text, its words and its `cue` (`src/rooms/learning/pm-rules.ts`).

| State | What happens | Failure |
|---|---|---|
| `candidate` | Waits for the night run with its masked text. | No analyzer model: the run stops, the candidates stay until the retention window ends. |
| `extracted` / `ignored` | Read by the night run: it gave an item, or nothing. | The text is cleared either way. |
| Lessons from runs | `collectLessonSources` gathers night findings, stage rejections and attempt failures, newest first (`packages/run-insights/src/lessons.ts`); the sweep counts candidates and advances its cursor, and repeating lessons become rule proposals (`src/rooms/self-repair/server/insights.ts`). | Drill tasks and noise reasons are excluded. |

`bb lane-pilot learning status` (or the PM: `lane_pilot_memory {action:"learned", op:"status"}`) shows what is waiting, what the filter
dropped in the last 7 days by reason, today's count against the cap, what the last night run did (`learning:last-night`), and the items.
There is no mode to switch and nothing to review by hand: the old observe/active switch and the check of the judges went with the judges.
`bb lane-pilot learning extract <projectId>` reads one project's candidates at once.

## Settings (`learning:config`, changed with `learning config key=value`)

| Setting | Default | |
|---|---|---|
| `enabled` | true | off: the hook ignores every message |
| `dailyCandidateCap` | 400 | candidates kept a day (UTC); the rest are recorded as skipped «cap» |
| `nightRuns` / `nightBatch` | 12 / 25 | runs of the model in a day, messages a run |
| `pmRulesTokens` / `writerRulesTokens` | 1600 / 1600 | token budget of the rules in force (was: 12 rules a pool) |

A record saved by an older version (with `mode`, `sample`, `dailyJudgeCap`, `secondOpinion`, ...) is read without those keys.

## Cost

One hidden model thread per batch of 25 messages per project, at night. About 200 tokens a message (masked text, the agent's reply tail,
JSON answer) plus about 1.5k for the instructions and the list of statements in force: a day of 100 candidates is four batches, about
30k input tokens, on the rules analyzer model. No per-message request and no outside service. A message too short, an acknowledgement,
machine text or a pasted log (over 12 000 characters) is never sent.

## Privacy

Sent to the rules analyzer model, by the night run only: the masked message (`maskPii`: e-mail, phone, card, IBAN, passport, INN, SNILS,
addresses) and the masked tail of the agent's reply before it. A message that matches the sensitive words (health, family, money,
documents, clients) is never sent, keeps no excerpt and no text, and nothing is extracted from it. The observation keeps a 280-character
masked excerpt; the masked text waits for the night run at most 36 hours. No key of an outside vendor is used.

## Lessons from runs (`collectLessonSources`)

Beside the owner's messages, a project learns from its own runs. `collectLessonSources(db, { projectId, since, limit })` returns what a project can learn from, newest first, in three forms (`packages/run-insights/src/lessons.ts:30-51`; kinds at `:4-7`):

- `night_finding` — the blocking and warning findings of a `night-review` receipt, each with the file, the finding and the suggested fix (`packages/run-insights/src/lessons.ts:16-27`);
- `rejection` — a failed or blocked receipt of the lesson stages (`night-review`, `acceptance-receipt`, `verification`, `code-critique`, `plan-critique`) whose reason is not noise (`packages/run-insights/src/lessons.ts:12`, `:41-45`);
- `attempt_failure` — a failed, blocked, rejected or `validation_failed` attempt that carries a reason (`packages/run-insights/src/lessons.ts:36-39`, `:47-49`).

Bounds: the limit is clamped to 1–2000, default 200 (`packages/run-insights/src/lessons.ts:31`); drill tasks (`drill-*`) are excluded from both queries (`packages/run-insights/src/lessons.ts:34`, `:38`); noise reasons — a retry limit, exhausted attempts, a cancel, a deleted thread, a plugin reload, `needs_human:` — are dropped (`packages/run-insights/src/lessons.ts:14`).

Who reads it: the lessons sweep counts the candidates per project and advances its cursor; failures are counted, not stored as memory, because raw failure logs crowded out knowledge on the hub (`src/rooms/self-repair/server/insights.ts:232-243`). `refreshRuleProposals` turns the lessons that repeat within a 30-day window into rule proposals and keeps the wording and decision of known ones (`src/rooms/self-repair/server/insights.ts:39-43`).
