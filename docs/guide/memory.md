---
title: Memory
topic: memory
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, memory]
updated: 2026-11-06
sources:
  - src/rooms/memory/server/memory.ts
  - src/rooms/memory/server/thread-block.ts
  - src/rooms/memory/server/import.ts
  - packages/memory-core/src/floor.ts
---

# Memory

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

Lane Pilot keeps one project memory, and it lives on the hub in the plugin's SQLite database (tables `lane_pilot_memory`, its FTS5 index and a trigram index). It is not a per-machine store: every machine, chat and agent reads and writes the same records. Sessions reach it through the hub RPCs `session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core` and `session_lesson`; a shell reaches it with `bb lane-pilot memory search "<question>"` and `bb lane-pilot memory write "<fact>"` (inside a BB thread the project is the thread's own). The engine is the `@lane-pilot/memory-core` package; the rooms are `memory`, `memory-tiers`, `memory-eval` and `memory-probe`.

## Who writes what

One owner per kind of knowledge (`docs/memory.md`, decision X-2, and the maintainer prompt):

| Store | Owns |
|---|---|
| Lane Pilot memory | Project technical facts, project rules, and since 2026-11-06 everything the other stores held (imported, see below) |
| Anamnesis | Facts about the owner, on the hub; a record marked `sensitive` is stored encrypted |
| BB memory, Claude Code auto-memory | Retired: imported into the Lane Pilot memory, the week of parallel running is over (done); switched off |
| agentmemory | Off on every machine since 2026-11-03; its data was imported. The write door refuses core records from origin `agentmemory`. |
| Code and docs | Behaviour |

A fact does not get a second author by being copied into another store. A rule that comes from a mistake is not memory: the rules pipeline owns it (see Self-improvement).

## Memory in every thread

Every ordinary BB thread of a project, on any machine, gets a short memory block at its start (path `bb.thread` in `MEMORY_PATHS`, `src/rooms/memory/server/thread-block.ts`): up to eight core facts of the project (at most 1200 characters) and two rule lines: search the memory with `bb lane-pilot memory search`, record with `bb lane-pilot memory write`, not into local memory files. Writers, errand helpers and repair threads get the two rule lines only (their brief already carries the facts). The PM and specialists keep their own memory tool, and hidden analyzer threads get nothing, since they may not run tools. The rule lives once, in the plugin on the hub, so no machine needs its own copy; a terminal session outside BB has the same line in `~/AGENTS.md`.

## Importing other memories

`scripts/memory-import.sh <bb-memory|claude-files|agentmemory> <jsonl> <project-id> [--dry-run]` (RPC `memory_import`) brings records from another store through the normal write door, so the same checks, duplicates and conflicts apply. The collectors `scripts/memory-collect-bb.sh`, `memory-collect-claude.py` and `memory-collect-agentmemory.py` write the JSONL. An import never evicts: when the records would push older notes off the shelf it writes nothing and says which budget it needs. `scripts/memory-import.sh eval <report.json>` (RPC `memory_import_eval`) asks the imported store questions and counts the answers. On 2026-11-06 the hub took 141 Claude Code records and 149 BB memory records with nothing evicted, and its note shelf (`memory.note_budget`) was raised to 200000 for it.

## Records

- **Kind.** `core` is always loaded for a role. `note` is retrieved by relevance. A rule is a core record tagged `rule`; the Knowledge tab lists rules apart and does not delete them through the facts action.
- **Audience.** `owner`, `subagent` (default) or `export`. `memory.personal_bot` isolates bot-scoped memory.
- **Scope.** A record belongs to the project root (`[]`) or to a section chain (`section:<id>`). A reader sees the root plus the prefixes of its own chain, never a sibling section. A reader that passes no chain sees the root only. Root core that names a file waits for a section unless it is tagged `convention`; a stored `memory.scope_map:<project>` can move such rows onto sections.
- **Trust.** `confirmed` (maintainer, rule, file, or two sources) or `observed` (one session wrote it). Observed notes reach writers after a second source or 24 hours. A hedged maintainer note ("maybe", "seems") is stored as observed.
- **Lifecycle.** `active`, `superseded` (a newer record replaced it) or `expired` (date passed, evicted for budget, idle 90 days, or a failed check quoted it). Hidden records stay in the table and leave every index.
- **Usefulness.** Each record counts how often it went into a brief and how often that attempt was accepted; the counters rank PM context and reviewer tiers.

## Session writes and the PM tools

A session on any machine can write a note through `session_memory_write` (kind `core` or `note`, content up to 8000 characters, up to 24 concepts). The hub stores it for the `subagent` audience as `observed` with origin `session`, under the section chain the caller passes, and returns `stored`, `corroborated` or `duplicate`; with memory disabled it returns `memory_disabled`. `session_memory_project` maps a folder to the deepest docs place that contains it, which gives the project and its scopes. `session_lesson` proposes a rule (8 to 600 characters) into the rules pipeline. The PM reaches memory through the `lane_pilot_memory` tool (its `context` and `learned` actions are documented) and its rules through the PM rules tool. The UI lists records with `memory_records_list` and deletes facts with `memory_record_delete`.

## Cold tier

Expired notes that have no end date and no replacement stay stored as a cold tier (idle expiry is 90 days without use). When a PM `lane_pilot_memory {action:"context"}` query finds fewer than three active notes, up to three matching cold notes are restored to active. Past tasks (episodes) that match the query are added, and a query that finds nothing is logged as a memory miss. `bb lane-pilot memory-tiers [--project P]` prints the cold count, the needed-again share and the recent misses. The misses feed the "miss curriculum" (`bb lane-pilot curriculum`).

## The maintainer

After an accepted task a stage `memory-maintenance` distils durable facts with a model that calls no tools. Every candidate is checked in code: it must be a JSON array, no credentials, no instruction-override text, and each claimed path, version or number must appear in the accepted result (unsupported ones are dropped). Rule-tagged entries are refused. Entries below the salience score (0 to 100: concepts +40, a concrete claim +35, 60 characters or more +25) are dropped before the write door. A core entry that does not fit the core budget is stored as a note. A restated note replaces the older one, dates and idleness expire notes, a full shelf hides the least useful notes, and a rule waiting for room can take the place of the oldest never-used maintainer conventions. The stage result records `stored`, `unsupportedDropped`, `salienceDropped`, `coreDemotedToNotes`, `evictedIds` and `supersededIds`.

| Setting | Default | Meaning |
|---|---|---|
| `memory.enabled` | `true` | Master switch |
| `memory.maintain` | `true` | Run the maintainer after accepted work |
| `memory.maintain_mode` | `wave` | `wave`: a free fact per accepted task, one maintainer run when the wave goes idle; `task`: one helper per task |
| `memory.maintain_every` | `3` | Run on every Nth accepted task |
| `memory.salience_min` | `40` | Admission floor, 0 to 100 |
| `memory.inject` | `true` | Put memory in writer briefs |
| `memory.audience` | `subagent` | `owner`, `subagent` or `export` |
| `memory.search_engine` | `auto` | `auto`, `fts5` or `bm25` |
| `memory.core_budget` / `note_budget` / `index_budget` | `3072` / `24000` / `65536` | Token caps (bytes / 4); over a note or index cap the whole batch is rejected |
| `memory.context_budget` | `2500` | Injected context cap; role caps apply on top |
| `memory.pack_mode` | `shadow` | ContextPack compiler stage (below) |
| `memory.personal_bot` | empty | Isolates bot-scoped memory (`claude`, `codex`, `grok`, `qwen`, `kimi`, `agy`, `cursor`) |
| `memory.agent`, `memory.provider` | `memory-maintainer`, `codex` with the onboarding model default | Role label and model of the maintainer |

## Relevance floor

`memory.query_floor` (default `on`) puts a relevance floor on the query paths: the PM memory tool, `session_memory_search`, the council and the context pack. Search used to return its best matches even when the question had nothing to do with memory, so a question the notes cannot answer got noise back. Now a record clears the floor when it names a path written in the question, or when the words it shares with the question add up to enough weight. A shared word weighs `ln(1 + notes / notes holding the word) / ln(1 + notes)`: a word only one note holds weighs close to 1, a word in half the notes about 0.1, so no stop-word list is needed. The weight a record must reach grows with the length of the question: 2 at 17 or more distinct words (a whole task text shares words by chance), 0 at 12 or fewer, linear between. After the floor, the answer gate (`answerProbability` in `packages/memory-core/src/floor.ts`) decides whether the memory answers the question at all: a logistic score over the cosine of the best record, the mean cosine of the best ten, the best record's z-score and the word weights, no model call. Below `ANSWER_GATE.min` (0.25) the tool answers «nothing»; the gate runs on the PM context and `bb lane-pilot memory search` and only when a meaning search ranked the records. Measured on the hub copy (150 questions with an answer, 228 without, held-out folds): 87% answered and 67% silent, against 96.7% and 96.1% for the Jev `memory.rerank` it replaced; that is the price of no model in the loop, and the coefficients belong to `gemini-embedding-2` (recalibrate with `bb lane-pilot memory-eval` when it changes). When nothing is left the tool answers "Memory has nothing relevant to this query. Do not assume or invent project facts; read the code or ask the owner." The writer's brief and the reviewers do not use the floor (their path anchors already are one). `off` restores the earlier behaviour; `bb lane-pilot memory-eval --floor` tunes the numbers on the evaluation set.

## Search by meaning

Every active record also has a vector: 768 numbers made by Google's `gemini-embedding-2` from the record's text (`packages/memory-core/src/vectors.ts`, table `lane_pilot_memory_vec`, made on first use). A five-minute schedule (`memory-embed`, `src/rooms/memory/server/embeddings.ts`) embeds new and changed records with the Env Catalog key `GEMINI_API_KEY_AISTUDIO`. The query paths (the PM memory tool, `bb lane-pilot memory search`, the writer's brief) embed the question first and rank the project's records by cosine; records that name a path written in the question come first. A question that could not be embedded (no key, timeout, error) or a project without vectors is searched by words as below, so nothing here can fail a search. Below a cosine of 0.65 (`DENSE_FLOOR`) a record is noise and dropped. The answer gate then decides whether the records answer at all (see the relevance floor above).

Measured on the hub copy 2026-11-06 with 853 questions: 625 written by a model from 298 real records (half of them in other words than the record) and 228 checked to have no answer in memory. The wanted record in the first five: words 59.7%, meaning 98.1% (adding the word ranking lowered it). With the floor and the removed Jev rerank: 96.7% of the answerable questions answered, 96.1% of the unanswerable ones answered «nothing» (the answer gate that replaced it: 87% and 67%); cosine alone cannot tell «close» from «answers» (at best about 70% «nothing»). The questions and the scripts live in the thread storage of `thr_exknr6pddz` (`tmp/mem-search`), not in this public repository: they quote the owner's memory.

## Search and injection

Search fuses an FTS5 word index (`bm25`) with an FTS5 trigram index (word forms and substrings), with a plain lexical fallback. Only active, in-date, non-held, in-scope records are visible. Query words are cut by a cheap suffix rule (two letters off words of six or more, never below four), so Russian endings still match; there is no real stemmer. Role caps on injected memory are PM 1600, writer 1600, critic 1200 and helper 600 tokens; a project may only narrow them. A writer brief carries at most three notes that name a folder of its task (in search order), then core conventions; a note whose named files changed since it was written is left out. Reviewers and the night review get up to five notes, with review-tagged notes and core conventions, and a drifted note is marked `[needs_review]`. `MEMORY_PATHS` registers every delivery path (writer brief, writer turn, repair round, PM start/resume, PM rules and memory tools, code critic, night review, council, scheduled agents).

## Conflicts

`findConflicts` compares a new note with active notes of the same project and audience, deterministically and without a model. Two notes conflict when they name the same file or share most tags and disagree on a value, a literal constant or a polarity. The older note is retired as `superseded` by the newer one and the pair is kept in `lane_pilot_memory_conflict`; one write that finds more than five pairs settles none. Older held pairs settle by hand: `bb lane-pilot memory-conflicts [--project P] [--state held|settled] [--detect]`, `bb lane-pilot memory-conflict-settle <mc_id> --keep a|b|both|none --evidence <why>`.

## Context pack compiler

`buildContextPack` compiles one pack per project, repo, section chain and role. Required sources (rules) pack first and a build fails with `context_pack_oversized` rather than cut a rule; optional notes go in by relevance and are cut first; stale notes are excluded for re-verification. On main the compiler runs in shadow only: with `memory.pack_mode` other than `off`, a pack is built next to the legacy writer mix and compared (kept, added, dropped, bytes), and nothing it builds is delivered.

## Proving memory works

- `bb lane-pilot memory-probe <project-id> [--paths a,b] [--keep] [--clean] [--report] [--force]` plants a note, a core convention and a rule with a unique token and checks that each registered path hands them to its agent (sandbox projects only unless `--force`). A drill scenario `memory_paths` runs it on every deploy.
- `bb lane-pilot memory-eval [--sizes 30,300,3000] [--seed N] [--scope project|pile] [--shelf] [--source f] [--export f] [--json]` (also `scripts/memory-eval.ts`) scores retrieval on real accepted tasks and on questions whose right answer is nothing, against a plain path-and-keyword baseline, with bootstrap intervals. `--shelf` replays the hub's history through the real write door. It found and fixed a ranking defect (writer hit@3 41 % to 62 %) and moved the default `memory.note_budget` to 24000 (hit@3 69 %).
- A frozen 40-case gate (`src/rooms/memory-eval/server/gate-fixture.json`: namespace, change, no-answer, needed, budget; 8 cases each) must show no leak, no cut rule and no overflow.
- `scripts/memory-unlearning-audit.ts` deletes a seeded fact the way `memory_record_delete` does and sweeps the indexes, searches, cold tier and conflict register for residue; it exits 1 on any leak.
- `scripts/memory-scope-dry-run.ts` lists scopes the reader cannot place; `--apply` rebinds bare-label scopes to sections with a journal, `--revert` restores them.

## UI

The Knowledge tab has Memory, Docs, Rules and Anamnesis segments. Memory shows the switch, the project's records (facts and rules apart, kind, date, concepts; only facts have a remove button, via `memory_record_delete`) and, in advanced mode, the settings above.

## Sources

Where this page's claims start in the code: `src/rooms/memory/server/memory.ts:30-50`, `src/rooms/memory/server/thread-block.ts:15-35`, `src/rooms/memory/server/import.ts:11-31`, `packages/memory-core/src/floor.ts:101-135`. The deep pages linked above cite the rest.
