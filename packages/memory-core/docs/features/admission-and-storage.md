---
title: Memory admission and storage
type: component
created: 2026-11-07
updated: 2026-11-13
status: active
confidence: medium
tags: [memory, admission, storage, budgets, eviction]
sources:
  - packages/memory-core/src/candidates.ts
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/settings.ts
  - packages/kit/src/redact.ts
  - packages/memory-core/src/fingerprint.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/conflict-store.ts
  - packages/memory-core/src/index.ts
  - src/rooms/memory/server/memory.ts
  - src/rooms/migrations.ts
  - src/rooms/memory/server/session-memory.ts
---

# Memory admission and storage

TL;DR: Memory admission parses candidate outputs, screens for credentials and instruction overrides, checks empirical support, enforces token budgets, and demotes or evicts records to fit shelves.

## Purpose

The admission and storage subsystem ensures that candidate facts are screened for security risks, validated against size and token budgets, assigned deterministic identity hashes, and stored in SQLite with automatic eviction of lower-utility notes (`packages/memory-core/src/candidates.ts:15-53, 76-82`, `packages/memory-core/src/store.ts:121-215`).

## How it works

1. Screening for security issues: `memoryContentIssue` rejects credential-shaped text using the shared shape table from `@lane-pilot/kit` plus memory-specific patterns, and rejects instruction overrides (`packages/memory-core/src/candidates.ts:13-24`, `packages/kit/src/redact.ts:106-128`).
2. Verification against source text: `memoryEntrySupported` extracts specific claims (paths, version numbers, numeric values) and verifies that each claim exists in the accepted task source text (`packages/memory-core/src/candidates.ts:40-53`). A paraphrase with no extracted specific claims passes (`packages/memory-core/src/candidates.ts:48-52`).
3. Salience scoring: `memoryEntrySalience` calculates a score from 0 to 100 by adding concepts (+40), a specific claim (+35), and content length of at least 60 characters (+25) (`packages/memory-core/src/candidates.ts:55-66`). The maintainer path filters entries below `memory.salience_min`, whose default is 40 (`src/rooms/memory/server/memory.ts:177-180`, `packages/memory-core/src/settings.ts:63`).
4. Parsing and structural validation: `parseMemoryCandidates` extracts a JSON array from raw model text (supporting code fences or raw bracketed text), limits arrays to 100 items, checks fields, normalizes concepts (up to 24 strings of <= 100 characters), validates ISO dates for `valid_from` and `valid_until`, and limits entry size to 64,000 bytes (`packages/memory-core/src/candidates.ts:84-94`, `packages/memory-core/src/candidates.ts:97-123`). Unknown fields still reject the entry unless their value is `null`, `false`, an empty string, or an empty array; `review`, `pitfall`, `invariant`, `security`, and `regression` set to `true` are added as concept tags when `concepts` is an array (`packages/memory-core/src/candidates.ts:105-113`).
5. Identity generation: `memoryRecordId` generates a SHA-256 hash identifying the record based on project ID, personal bot, kind, normalized content, audience, and scope chain (`packages/memory-core/src/candidates.ts:70-82`).
6. Storage transaction: `storeMemoryRecords` initiates an immediate SQLite transaction (`packages/memory-core/src/store.ts:121-127`):
   - Validates that non-rule origins do not specify the concept `"rule"` (`packages/memory-core/src/store.ts:131-132`).
   - Prevents the `"agentmemory"` origin from creating `"core"` records (`packages/memory-core/src/store.ts:134`).
   - Runs `expireMemory` to mark dated and 90-day idle records as expired (`packages/memory-core/src/store.ts:135`).
   - Classifies existing records: revives expired records if restated, corroborates observed records if confirmed by another source, or marks them as pending insertion (`packages/memory-core/src/store.ts:144-154`).
   - Evaluates note replacement: checks `supersedes` prefixes, matching `sourceFileId`, and `sameSubject` similarity (`packages/memory-core/src/store.ts:174-188`).
   - Holds replacements for active notes used within the last 30 days as conflicts instead of overwriting them (`packages/memory-core/src/store.ts:158-168`).
7. Budget enforcement and eviction: calculates total token usage via `estimateTokens` (`packages/memory-core/src/candidates.ts:68`). If notes exceed `noteBudget` or combined tokens exceed `indexBudget` (`packages/memory-core/src/store.ts:205-215`), least useful notes are hidden (sorted by `accepted_count`, `use_count`, `last_used_at`, `created_at`, `id` in `packages/memory-core/src/store.ts:209-215`) until the batch fits.
8. Overflow demotion: when calling `storeMemoryRecordsKeepingOverflow`, `demoted` tracks core records converted to kind `"note"` (`packages/memory-core/src/store.ts:271-283`) when exceeding `coreBudget` (`packages/memory-core/src/store.ts:200-203`).
9. Search index updates: newly inserted and revived records are inserted into `lane_pilot_memory_fts` and `lane_pilot_memory_trgm` via `addToIndexes` (`packages/memory-core/src/store.ts:84-88`, `packages/memory-core/src/store.ts:225-226, 228-232`).
10. Direct corpus seeding: `insertMemoryRecord` (`packages/memory-core/src/store.ts:550-554`) writes a single memory record directly with `personal_bot = ''`, `audience = 'subagent'`, and `trust = 'confirmed'`, bypassing candidate validation, budgeting, indexing, and conflict checks for eval corpus seeding.

## Modes, variants and branches

| Variant / Branch | Inputs and triggers | Limits and thresholds | Outputs and behavior | Evidence |
|---|---|---|---|---|
| Direct write (`storeMemoryRecords`) | Direct invocation by rules engine or tests | Fixed `coreBudget`, `noteBudget`, `indexBudget` | Inserts records; throws if core exceeds `coreBudget` | `packages/memory-core/src/store.ts:89-91, 200-215` |
| Overflow write (`storeMemoryRecordsKeepingOverflow`) | Maintainer write path | Same budgets | `demoted` tracks excess core records demoted to note kind (`packages/memory-core/src/store.ts:271-283`) | Demoted to note shelf |
| Direct corpus seed (`insertMemoryRecord`) | Evaluation corpus input | Bypasses admission filters, budgets, and indexing | Directly inserts with `trust='confirmed'` and `audience='subagent'`; the schema default sets `status='active'` | `packages/memory-core/src/store.ts:552-556`, `src/rooms/migrations.ts:286` |
| Hedged claim | Note containing words like "maybe", "perhaps", "кажется", "возможно" | `claimIsHedged(content)` matches regex | Forces `trust='observed'` even if input requested `confirmed` | `packages/memory-core/src/store.ts:114-119`, `packages/memory-core/src/store.ts:125` |
| Candidate salience | Maintainer candidate before the write door | `memoryEntrySalience` score (`packages/memory-core/src/candidates.ts:60-66`) vs `memory.salience_min` (default 40, effective range 1–100) (`packages/memory-core/src/settings.ts:49-53, 63`) | Maintainer path drops entries below the floor; the parser does not apply this gate | `src/rooms/memory/server/memory.ts:177-180` |
| Rule origin | Input with `origin: "rule"` | Restricted to rules pipeline | Allowed to attach `"rule"` concept tag | `packages/memory-core/src/store.ts:131-132` |
| Agentmemory origin | Input with `origin: "agentmemory"` | Cannot author core | Restricted to note records only | `packages/memory-core/src/store.ts:133-134` |

## Failure behavior

| Failure condition | Trigger point | Error / Outcome | Evidence |
|---|---|---|---|
| Credential detected | Shared credential shape or memory-specific pattern matches content | Throws `"memory content appears to contain a credential; no memory was saved"` | `packages/memory-core/src/candidates.ts:13-14, 21-23` |
| Instruction injection | Instruction override pattern matched in content | Throws `"memory content addresses the assistant with an instruction override; no memory was saved"` | `packages/memory-core/src/candidates.ts:15, 21-24` |
| Oversize candidate content | Content > 64,000 bytes or empty | Throws `"memory content is empty or exceeds the 64000 byte limit"` | `packages/memory-core/src/candidates.ts:115` |
| Unsupported fields (`KNOWN_FIELDS`) | Unknown property with a non-empty value, except a recognized reviewer concept set to `true` when `concepts` is an array | Throws `"memory entry contains unsupported fields"`; empty extras are discarded and reviewer booleans become concept tags | `packages/memory-core/src/candidates.ts:99-107` |
| Invalid concepts | Concept count > 24, non-string or blank item, or string > 100 chars | Throws `"memory concepts must be up to 24 short strings"` | `packages/memory-core/src/candidates.ts:118` |
| Invalid supersedes | More than 5 IDs or ID outside the 12–64 lowercase hex format | Throws `"memory supersedes must be up to 5 record ids (12 to 64 hex characters)"` | `packages/memory-core/src/candidates.ts:119` |
| Core budget exceeded | Core tokens > `coreBudget` in `storeMemoryRecords` | Throws `"memory core budget exceeded: <core>/<budget> tokens"` | `packages/memory-core/src/store.ts:200-203` |
| Note budget exceeded after eviction | Even after evicting all eligible notes, batch does not fit | Throws `"memory note budget exceeded: <left>/<budget> tokens"` | `packages/memory-core/src/store.ts:203-212` |
| Index budget exceeded after eviction | Even after evicting all eligible notes, combined tokens exceed budget | Throws `"memory index budget exceeded: <total>/<budget> tokens"` | `packages/memory-core/src/store.ts:203-212` |

## Business rules

- Token estimation rule: token count is computed deterministically as UTF-8 byte length divided by 4, rounded up (`packages/memory-core/src/candidates.ts:68`).
- Credential-key matching is case-sensitive for colon forms: lowercase keys such as `password:` are refused, while uppercase key names are additionally refused when written with `=`; ordinary prose such as `CLIENT_SECRET: rotate monthly` remains storable (`packages/memory-core/src/candidates.ts:9-14`).
- Admission fields rule: retained candidate fields are restricted to `kind`, `content`, `concepts`, `supersedes`, `valid_until`, and `valid_from`; empty unknown fields are discarded (`packages/memory-core/src/candidates.ts:6-8, 107-113`).
- Concept normalization: concepts are trimmed, lowercased, and deduplicated (`packages/memory-core/src/candidates.ts:122-123`).
- Single-claim screening is a separate check: `memoryClaimIssue` flags content with at least three list lines; parsing itself does not invoke that check (`packages/memory-core/src/candidates.ts:27-38`, `packages/memory-core/src/candidates.ts:97-135`).
- Eviction priority: core records and rules (`isRule` checking `concepts_json` in `packages/memory-core/src/store.ts:43`, `packages/memory-core/src/store.ts:209-210`) are protected and never evicted. Notes are evicted in ascending order of `accepted_count`, then `use_count`, then `last_used_at` (or `created_at`), then `created_at`, then `id` (`packages/memory-core/src/store.ts:209-210`).
- Namespace boundary: record replacements are strictly confined to the same project, personal bot, audience, and section scope (`packages/memory-core/src/store.ts:176, 180-181`).

## Public API or commands

- `memoryContentIssue(content: string): string | null`: checks text against shared and memory-specific credential patterns and instruction overrides (`packages/memory-core/src/candidates.ts:13-24`).
- `memoryEntrySupported(content: string, sourceText: string): boolean`: checks whether extracted specific claims exist in source text; text with no such claims passes (`packages/memory-core/src/candidates.ts:48-53`).
- `memoryEntrySalience(entry: { kind: string; content: string; concepts: readonly string[] }): number`: scores entry utility from 0 to 100 (`packages/memory-core/src/candidates.ts:60-66`).
- `memoryClaimIssue(content: string): string | null`: returns a split-into-notes issue when content contains at least three list lines (`packages/memory-core/src/candidates.ts:35-38`).
- `estimateTokens(text: string): number`: computes ceiling of UTF-8 byte length divided by 4 (`packages/memory-core/src/candidates.ts:68`).
- `memoryRecordId(projectId: string, kind: MemoryKind, content: string, personalBot?: string, audience?: string, scope?: readonly string[]): string`: generates deterministic SHA-256 record hash (`packages/memory-core/src/candidates.ts:76-82`).
- `parseMemoryCandidates(raw: unknown, settings: MemorySettings): MemoryCandidate[]`: parses and validates candidate entries (`packages/memory-core/src/candidates.ts:97-135`).
- `storeMemoryRecords(db: MemoryDatabase, input: StoreMemoryInput): StoreMemoryResult`: writes records within budgets in a transaction (`packages/memory-core/src/store.ts:121-240`).
- `storeMemoryRecordsKeepingOverflow(db: MemoryDatabase, input: StoreMemoryInput): StoreMemoryResult & { entries: MemoryCandidate[]; demoted: number }`: writes records, demoting core overflows to notes (`packages/memory-core/src/store.ts:262-274`).
- `insertMemoryRecord(db: MemoryDatabase, input: { id: string; projectId: string; kind: string; content: string; conceptsJson: string; sourceSha256: string; createdAt: number; origin: string }): void`: directly inserts an eval corpus row without admission or indexing side effects (`packages/memory-core/src/store.ts:552-556`).
- `deleteMemoryRecord(db: Database.Database, projectId: string, id: string): string[]`: removes a record and its indexes, embedding, promotion, and conflict rows; returns deferral IDs for held conflicts so callers can close them (`packages/memory-core/src/store.ts:445-465`).
- `coreShelf(db: MemoryDatabase, projectId: string, personalBot: string, audience: MemoryAudience, scope?: readonly string[])`: returns active core token counts and replaceable records (`packages/memory-core/src/store.ts:255-260`).

## Gotchas

- Calling `storeMemoryRecords` directly throws an unhandled exception when core tokens exceed `coreBudget` (`packages/memory-core/src/store.ts:194`), dropping candidate notes unless handled by `demoted` overflow processing (`packages/memory-core/src/store.ts:262-274`).
- One candidate entry that exceeds total `noteBudget` by itself cannot cause the eviction of existing notes; eviction aborts if clearing all notes still cannot fit the batch (`packages/memory-core/src/store.ts:198-205`).
- Hedged notes ("maybe", "perhaps") are automatically converted to `trust='observed'` even when submitted with `trust='confirmed'`, delaying their delivery to working sessions for 24 hours (`packages/memory-core/src/store.ts:125`, `packages/memory-core/src/lifecycle.ts:5`).
- In-memory SQLite transaction is opened with `immediate()`, requiring SQLite lock acquisition before execution begins (`packages/memory-core/src/store.ts:248`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core workspace overview](../overview.md)
