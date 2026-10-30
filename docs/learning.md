---
title: Learning from the owner's messages
type: component
created: 2026-10-08
updated: 2026-10-29
status: active
confidence: medium
tags: [learning, rules, jev, owner-messages, lessons]
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

Design of 2026-10-08 (T1-T8), code in `src/learning`. The owner's own messages to his agents are judged where he says them; what
teaches something becomes a rule, a decision, a preference or a reminder, with the message it came from.

```
owner message (a person's request in a visible top-level thread: the one collector of src/anamnesis/owner-messages.ts)
  -> live feed (thread.active / thread.idle / experimental_thread.events -> read the new client/turn/requested)
  -> observer: skip acknowledgements, the sample, the daily cap; mask personal data; sensitive text stays with Jev
  -> Jev learning.owner_message (kind, worth remembering, reach, annoyance, date)          -> route learn / none / contested
  -> OpenAI Decisions gpt-6-luna for contested, for Jev's failures, for a sample           -> final route
  observe mode stops here (a row in lane_pilot_learning_obs)
  active mode:  learn -> masked text kept -> extractor (JSON) -> compare with what is in force (Jev learning.same_as)
        rule/preference, project   -> Lane Pilot rule on trial (audience pm|writer|both)
        rule/preference, owner     -> accepted by itself -> the PM runs `bb memory add --scope global --kind preference`
        decision                   -> note in the project's memory
        date                       -> accepted by itself -> reminder in the thread
        fact                       -> recorded only (the anamnesis owns facts about the owner)
        same as one in force       -> confirmation; opposite -> replaces the old one, the new rule on trial
        annoyance                  -> kv record -> self-repair incident of kind `owner`
  every extractor tick (autonomy.ts): what waited for a yes is accepted; daily 18:20: one report per project to the PM chat
```

## How it works

1. The collector hands the owner's messages of a visible top-level thread to the observer (`src/rooms/anamnesis/owner-messages.ts`).
2. The observer applies the skip rules, the sample and the daily Jev cap, masks personal data, and inserts the observation with its state: a policy skip becomes `skipped`, an active learn route becomes `candidate`, the rest stay `observed` (`src/rooms/learning/observe.ts:80-95`, `:113-126`). A sensitive message keeps neither excerpt nor text (`src/rooms/learning/migrations.ts:4-6`).
3. In `active` mode the extractor proposes the item and `route` compares it with what is in force, choosing the initial state — `rule`, `preference`, `decision`, `deadline` or `fact`, as `adopted`, `proposed`, `pending_owner`, `duplicate`, `dropped` or `noted` (`src/rooms/learning/extract.ts:175-208`, kinds and states at `src/rooms/learning/migrations.ts:49-68`).
4. Owner decisions settle the waiting items: `accept` stores the reminder or memory or adopts the rule; `reject` and `drop` end them (`src/rooms/learning/decide.ts:45-80`, `:84-91`). The autonomy reviewer does the same without the owner once its accuracy bar holds (`src/rooms/learning/autonomy.ts`).
5. A read candidate is cleared of body text; an unread candidate turns `ignored` after the retention window (`src/rooms/learning/store.ts:71-80`).

| Mode or state | What happens | Failure |
|---|---|---|
| `observe` | Judged and recorded, nothing acts. | A Jev error or timeout records the message within the daily cap; receipts keep hash and size only. |
| `active` | Learn-routed messages are extracted, compared and routed to a rule on trial, a preference, a decision, a reminder or a recorded fact. | A rule on trial stays on trial until adopted; `same_as` confirms or replaces what is in force. |
| Lessons from runs | `collectLessonSources` gathers night findings, stage rejections and attempt failures, newest first (`packages/run-insights/src/lessons.ts:30-51`); the sweep counts candidates and advances its cursor (`src/rooms/self-repair/server/insights.ts:229-240`), and repeating lessons become rule proposals (`src/rooms/self-repair/server/insights.ts:39-43`). | Drill tasks and noise reasons are excluded (`packages/run-insights/src/lessons.ts:14`, `:34`, `:38`). |

## Switching on

It starts in `observe`: judged and recorded, nothing else. The owner takes no part in switching it on (owner out of the loop,
2026-10-23): every three hours (`learning-review`, at most four runs a day) a strong model of its own — the project's rules analyzer,
not Jev and not the second opinion — checks a batch of 25 judged messages and labels each decision right or wrong
(`src/rooms/learning/autonomy.ts`). `bb lane-pilot learning status` (or the PM: `lane_pilot_memory {action:"learned", op:"status"}`)
lists what is missing for `active`: seven days of observation and 50 checked cases at 80 % or better. When both hold, learning
switches itself to `active` and logs why; below 80 % it keeps observing, because the judges need fixing, not a person.
`label <id> ok|wrong` still adds a mark by hand, and `config mode=observe` stops acting.

## Settings (`learning:config`, changed with `learning config key=value`)

| Setting | Default | |
|---|---|---|
| `enabled` | true | off: the hook ignores every message |
| `mode` | observe | `observe` or `active` |
| `sample` | 1 | share of eligible messages that are judged (stable by message id) |
| `dailyJudgeCap` | 300 | Jev judgments a day (UTC); the rest are recorded as skipped |
| `secondOpinion` | true | OpenAI Decisions at all |
| `secondOpinionDailyCap` | 60 | second opinions a day |
| `agreeSample` | 0.1 | share of sure messages that also get a second opinion, for the agreement report |
| `extractorRunsPerDay` / `extractorBatch` | 6 / 12 | runs of the short model a day, messages a run |
| `pmRulesTokens` / `writerRulesTokens` | 1600 / 1600 | token budget of the rules in force (was: 12 rules a pool) |

## Cost

Jev about 1.1k input tokens a message. The second opinion: 200 ms median, $0.10 per million input tokens, so a hundred cost about one
cent. The extractor is one hidden model thread per project per run (at most 6 a day). A message too short, an acknowledgement or a
pasted log (over 12 000 characters) is never sent. Receipts: the shared `lane_pilot_jev_receipt` (hash and size, never the text) and
the observation row's second-opinion tokens and latency.

## Privacy

Sent outside: the masked message (`maskPii`: e-mail, phone, card, IBAN, passport, INN, SNILS, addresses) and the masked tail of the
agent's reply before it. A message that matches the sensitive words (health, family, money, documents, clients) goes to Jev only, keeps no
excerpt and no text, and nothing is extracted from it. The observation keeps a 280-character masked excerpt (for the hand review);
the masked text waits for the extractor at most a day. The key `OPENAI_API_KEY` is read from the Env Catalog by name, held in memory ten
minutes, never logged.

## Lessons from runs (`collectLessonSources`)

Beside the owner's messages, a project learns from its own runs. `collectLessonSources(db, { projectId, since, limit })` returns what a project can learn from, newest first, in three forms (`packages/run-insights/src/lessons.ts:30-51`; kinds at `:4-7`):

- `night_finding` — the blocking and warning findings of a `night-review` receipt, each with the file, the finding and the suggested fix (`packages/run-insights/src/lessons.ts:16-27`);
- `rejection` — a failed or blocked receipt of the lesson stages (`night-review`, `acceptance-receipt`, `verification`, `code-critique`, `plan-critique`) whose reason is not noise (`packages/run-insights/src/lessons.ts:12`, `:41-45`);
- `attempt_failure` — a failed, blocked, rejected or `validation_failed` attempt that carries a reason (`packages/run-insights/src/lessons.ts:36-39`, `:47-49`).

Bounds: the limit is clamped to 1–2000, default 200 (`packages/run-insights/src/lessons.ts:31`); drill tasks (`drill-*`) are excluded from both queries (`packages/run-insights/src/lessons.ts:34`, `:38`); noise reasons — a retry limit, exhausted attempts, a cancel, a deleted thread, a plugin reload, `needs_human:` — are dropped (`packages/run-insights/src/lessons.ts:14`).

Who reads it: the lessons sweep counts the candidates per project and advances its cursor; failures are counted, not stored as memory, because raw failure logs crowded out knowledge on the hub (`src/rooms/self-repair/server/insights.ts:229-240`). `refreshRuleProposals` turns the lessons that repeat within a 30-day window into rule proposals and keeps the wording and decision of known ones (`src/rooms/self-repair/server/insights.ts:39-43`).
