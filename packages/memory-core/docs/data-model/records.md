---
title: Memory records and receipts data model
type: data-model
created: 2026-11-07
updated: 2026-11-11
status: active
confidence: medium
tags: [memory, data-model, records, receipts, sqlite, lifecycle]
sources:
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/candidates.ts
  - packages/memory-core/src/settings.ts
  - packages/memory-core/src/fingerprint.ts
  - src/rooms/memory/server/attempt-effects.ts
  - packages/memory-core/src/files.ts
  - packages/memory-core/src/sections.ts
  - packages/memory-core/src/vectors.ts
  - src/rooms/writer/server/spawn.ts
  - scripts/lp-wall-morning.sql
  - tests/server/memory-receipt.test.ts
  - src/rooms/migrations.ts
---

# Memory records and receipts data model

TL;DR: The `lane_pilot_memory` table stores project facts and rules with lifecycle statuses, accompanied by FTS5 virtual indexes and retrieval receipts.

## Entity relationships

```mermaid
erDiagram
  lane_pilot_memory ||--o{ lane_pilot_memory_receipt : audited_in
  lane_pilot_memory ||--o{ lane_pilot_memory_fts : fulltext_index
  lane_pilot_memory ||--o{ lane_pilot_memory_trgm : trigram_index

  lane_pilot_memory {
    TEXT id PK
    TEXT project_id PK
    TEXT personal_bot
    TEXT kind
    TEXT audience
    TEXT content
    TEXT concepts_json
    TEXT source_sha256
    INTEGER created_at
    TEXT status
    TEXT trust
    INTEGER valid_until
    INTEGER valid_from
    TEXT superseded_by
    TEXT source_file_id
    INTEGER use_count
    INTEGER accepted_count
    INTEGER last_used_at
    TEXT file_fingerprint
    TEXT origin_task_id
    TEXT verification_json
    TEXT scope_json
    TEXT expired_reason
    INTEGER critic_count
  }

  lane_pilot_memory_receipt {
    TEXT id PK
    TEXT project_id
    TEXT role
    TEXT returned_ids
    TEXT packed_ids
    INTEGER tokens
    INTEGER created_at
  }
```

## Table: `lane_pilot_memory`

Purpose: canonical storage for project conventions (`kind = 'core'`) and contextual facts (`kind = 'note'`) (`packages/memory-core/src/store.ts:15-20`).

| Field | Meaning | Allowed values and source | Units / Format | Evidence |
|---|---|---|---|---|
| `id` | Unique record identity hash | 64-character SHA-256 hex string computed by `memoryRecordId` | Hex string | `packages/memory-core/src/candidates.ts:70-78` |
| `project_id` | Project identifier owning the record | Non-empty project string from environment or settings | UTF-8 string | `packages/memory-core/src/store.ts:26` |
| `personal_bot` (`packages/memory-core/src/store.ts:18`) | Bot namespace from `MEMORY_PERSONAL_BOTS` (`packages/memory-core/src/settings.ts:3`) parsed as `personalBot` (`packages/memory-core/src/settings.ts:58`) | Allowed bot names | String | `packages/memory-core/src/store.ts:18` |
| `kind` (`packages/memory-core/src/store.ts:18`) | Storage category typed by `MemoryKind` (`packages/memory-core/src/settings.ts:6`) | `"core"` or `"note"` | String | `packages/memory-core/src/store.ts:18` |
| `audience` (`packages/memory-core/src/store.ts:18`) | Visibility level from `MEMORY_AUDIENCES` (`packages/memory-core/src/settings.ts:1`) typed by `MemoryAudience` (`packages/memory-core/src/settings.ts:4`) | `"owner"`, `"subagent"`, `"export"` | String | `packages/memory-core/src/store.ts:18` |
| `content` (`packages/memory-core/src/store.ts:18`) | Fact text up to `MAX_ENTRY_BYTES` (`packages/memory-core/src/candidates.ts:4, 109`), screened by `memoryContentIssue` (`packages/memory-core/src/candidates.ts:15-19`) | Text string | UTF-8 text | `packages/memory-core/src/store.ts:18` |
| `concepts_json` (`packages/memory-core/src/store.ts:18`) | Serialized `concepts` array parsed in `candidates.ts` (`packages/memory-core/src/candidates.ts:112, 116-117`) | Up to 24 strings | JSON string | `packages/memory-core/src/store.ts:18` |
| `source_sha256` | Hash of source material distilling this fact | 64-character SHA-256 hex string | Hex string | `packages/memory-core/src/store.ts:26` |
| `created_at` (`packages/memory-core/src/store.ts:18`) | Epoch timestamp recorded at insertion time | Milliseconds since Unix epoch | Epoch ms | `packages/memory-core/src/store.ts:18` |
| `status` (`packages/memory-core/src/store.ts:19`) | Corpus status typed by `MemoryStatus` (`packages/memory-core/src/settings.ts:8-9`) | `"active"`, `"superseded"`, `"expired"` | String | `packages/memory-core/src/store.ts:19` |
| `trust` (`packages/memory-core/src/store.ts:19`) | Source trustworthiness typed by `MemoryTrust` (`packages/memory-core/src/settings.ts:10-11`) | `"confirmed"`, `"observed"` | String | `packages/memory-core/src/store.ts:19` |
| `valid_until` (`packages/memory-core/src/store.ts:19`) | Expiration timestamp mapped from candidate `validUntil` (`packages/memory-core/src/settings.ts:17`) | Epoch ms or null | Epoch ms | `packages/memory-core/src/store.ts:19` |
| `valid_from` (`packages/memory-core/src/store.ts:19`) | Start timestamp mapped from candidate `validFrom` (`packages/memory-core/src/settings.ts:19`) | Epoch ms | Epoch ms | `packages/memory-core/src/store.ts:19` |
| `superseded_by` | ID of replacement record | 64-char hex record ID or null | Hex string | `packages/memory-core/src/store.ts:31` |
| `source_file_id` (`packages/memory-core/src/store.ts:19`) | File identifier from `sourceFileId` (`packages/memory-core/src/files.ts:106`) | File ID string or null | String | `packages/memory-core/src/store.ts:19` |
| `use_count` | Number of times delivered in briefs | Non-negative integer incremented by `recordMemoryMixed` | Count | `packages/memory-core/src/lifecycle.ts:96` |
| `accepted_count` | Number of successful attempts using this fact | Non-negative integer incremented by `recordMemoryAccepted` | Count | `packages/memory-core/src/lifecycle.ts:115` |
| `last_used_at` | Timestamp of last brief delivery | Epoch ms or null if never delivered | Epoch ms | `packages/memory-core/src/lifecycle.ts:96` |
| `file_fingerprint` (`packages/memory-core/src/store.ts:19`) | Content hash from `fileFingerprint` (`packages/memory-core/src/fingerprint.ts:14-23`) | 16-character hex hash or null | Hex string | `packages/memory-core/src/store.ts:19` |
| `origin_task_id` (`packages/memory-core/src/store.ts:19`) | Task identifier from input `originTaskId` (`packages/memory-core/src/store.ts:99`) | Task ID string or null | String | `packages/memory-core/src/store.ts:19` |
| `verification_json` | Audit list of vouchers | JSON array of `{ by: string, sha: string, at: number }` objects | JSON string | `packages/memory-core/src/store.ts:40-42, 220` |
| `scope_json` (`packages/memory-core/src/store.ts:19`) | Scope hierarchy array managed via `sharedScope` and `UNASSIGNED_SCOPE` (`packages/memory-core/src/sections.ts:18-20`) | Scopes array | JSON string | `packages/memory-core/src/store.ts:19` |
| `expired_reason` | Retirement cause typed by `ExpiredReason` (`packages/memory-core/src/lifecycle.ts:9-10`) | `"budget"`, `"idle"`, `"dated"`, `"refuted"`, `"revoked"`, `"archived"`, `"owner"`, or null | String | `packages/memory-core/src/lifecycle.ts:9-10` |
| `critic_count` | Number of times inspected by reviewers | Non-negative integer incremented by `recordCriticUse` | Count | `packages/memory-core/src/lifecycle.ts:109-111` |

### Lifecycle of `status`

| Initial state | Next state | Function | Trigger condition | Evidence |
|---|---|---|---|---|
| (new) | `"active"` | `storeMemoryRecords` (`packages/memory-core/src/store.ts:214-224`) | Candidate passes admission checks and budgets | `packages/memory-core/src/store.ts:214-224` |
| (new) | `"active"` | `insertMemoryRecord` (`packages/memory-core/src/store.ts:550-556`) | Evaluation corpus seed row inserted directly | `packages/memory-core/src/store.ts:550-556` |
| `"active"` | `"superseded"` | `hideRecord` (`packages/memory-core/src/lifecycle.ts:31-35`) | Replaced by newer record via `supersedes` (`packages/memory-core/src/store.ts:188-193`), `sourceFileId` (`packages/memory-core/src/store.ts:181-183`), or `sameSubject` (`packages/memory-core/src/store.ts:192-193`) | `packages/memory-core/src/store.ts:176-179` |
| `"active"` | `"expired"` | `hideRecord` (`packages/memory-core/src/lifecycle.ts:31-34`) | Evicted for budget (`expired_reason = 'budget'`) | `packages/memory-core/src/store.ts:201-212` |
| `"active"` | `"expired"` | `hideRecord` (`packages/memory-core/src/lifecycle.ts:31-35`) | Not used for 90 days (`expired_reason = 'idle'`) | `packages/memory-core/src/lifecycle.ts:38-42` |
| `"active"` | `"expired"` | `hideRecord` (`packages/memory-core/src/lifecycle.ts:31-35`) | Valid date passed (`valid_until <= now`, `expired_reason = 'dated'`) | `packages/memory-core/src/lifecycle.ts:38-42` |
| `"active"` | `"expired"` | `hideRecord` (`packages/memory-core/src/lifecycle.ts:31-35`) | Refuted by `noteRefutedByCheck` (`packages/memory-core/src/lifecycle.ts:13-18, 31-34`, `src/rooms/memory/server/attempt-effects.ts:13`) | Reason `"refuted"` |
| `"active"` | `"expired"` | `expireIdleMemory` (`packages/memory-core/src/store.ts:524-528`) | Promoted note remaining idle past evaluation window (`listIdlePromotions`) | Reason `"idle"` |
| `"active"` | `"expired"` | `hideRecord` (`packages/memory-core/src/lifecycle.ts:31-34`) | Caller records owner withdrawal (`"revoked"`), archival (`"archived"`), or owner forget/replace tombstone (`"owner"`) as the reason | `packages/memory-core/src/lifecycle.ts:9-10, 31-34`; owner tombstone handling: `packages/memory-core/src/store.ts:154-160` |
| `"expired"` | `"active"` | `storeMemoryRecords` (`packages/memory-core/src/store.ts:154-162, 228-231`) | A restated expired record revives unless its reason is `"owner"`, `"revoked"`, or `"archived"` | `packages/memory-core/src/store.ts:154-162` |
| `"expired"` | `"active"` | `reactivateColdMemory` (`packages/memory-core/src/store.ts:499-513`) | Cold idle or archived note re-activated during cold-tier retrieval | Resets `last_used_at`; archived rows are cold-tier candidates | `packages/memory-core/src/store.ts:499-513` |

### Lifecycle of `trust`

| Initial state | Next state | Function | Trigger condition | Evidence |
|---|---|---|---|---|
| (new) | `"confirmed"` | `storeMemoryRecords` (`packages/memory-core/src/store.ts:214`) | Inserted with confirmed trust, rule origin, or file origin without hedging | `packages/memory-core/src/store.ts:123-125` |
| (new) | `"observed"` | `storeMemoryRecords` (`packages/memory-core/src/store.ts:214`) | Inserted with observed trust or contains hedged phrasing | `packages/memory-core/src/store.ts:125` |
| `"observed"` | `"confirmed"` | `verify` in `store.ts` (`packages/memory-core/src/store.ts:225-234`) | Corroborated when `source_sha256` differs (`packages/memory-core/src/store.ts:150`) | Upgraded to confirmed |

### Invariants

- `id` is the primary key; `(project_id, id)` also has a unique constraint (`src/rooms/migrations.ts:160-169`).
- Protected shelves: core records (`kind = 'core'`) and rules (`isRule` in `packages/memory-core/src/store.ts:43`) are filtered from `victims` (`packages/memory-core/src/store.ts:200`) and never evicted.
- Index synchronization: active records are registered via `addToIndexes` (`packages/memory-core/src/store.ts:84-87`, `packages/memory-core/src/store.ts:216`, `packages/memory-core/src/store.ts:222`). Inactive records are purged by `dropMemoryIndexes` (`packages/memory-core/src/store.ts:78-81`) passed to `hideRecord` (`packages/memory-core/src/lifecycle.ts:30-34`).

### Writers and readers

- Writers:
  - `storeMemoryRecords` / `storeMemoryRecordsKeepingOverflow`: insert new candidates, demote core overflows, update indexes (`packages/memory-core/src/store.ts:121-240, 262-274`).
  - `insertMemoryRecord`: direct row insertion for corpus evaluation without admission or indexing side effects (`packages/memory-core/src/store.ts:550-556`).
  - `deleteMemoryRecord`: removes a record and drops search indexes (`packages/memory-core/src/store.ts:448-464`).
  - `reactivateColdMemory`: re-activates an idle or archived cold note (`packages/memory-core/src/store.ts:499-513`).
  - `recordMemoryPromotion`: records a promotion row on reactivation (`packages/memory-core/src/store.ts:513-517`).
  - `expireIdleMemory`: expires a still-active note as idle during demote sweep (`packages/memory-core/src/store.ts:524-528`).
  - `recordMemoryMiss` / `listMemoryMisses`: logs and reads search queries with zero hits (`packages/memory-core/src/store.ts:539-548, 693-707`).
  - `recordMemoryProbe` / `pruneMemoryProbeBefore`: logs and prunes probe evaluation results (`packages/memory-core/src/store.ts:595-599, 608-611`).
  - `expireMemory`: scans and expires idle/dated records (`packages/memory-core/src/lifecycle.ts:37-41`).
  - `hideRecordsOfFile`: marks records superseded/expired when their source file is deleted or modified (`packages/memory-core/src/store.ts:286-289`).
  - `recordMemoryMixed` / `recordMemoryAccepted` / `recordCriticUse`: update usage counters and timestamps (`packages/memory-core/src/lifecycle.ts:94-97, 108-117`).
- Readers:
  - `searchMemoryRecords` / `searchMemoryAllSections`: FTS5 and trigram searches (`packages/memory-core/src/store.ts:319-359`).
  - `listMemory`: tag and kind listing (`packages/memory-core/src/store.ts:404-411`).
  - `listActiveMemoryRows`: queries active records of a project (`packages/memory-core/src/store.ts:482-490`).
  - `coldMemoryRows`: idle-expired and owner-archived note rows for cold-tier read (`packages/memory-core/src/store.ts:499-507`).
  - `listIdlePromotions`: lists promoted notes staying idle (`packages/memory-core/src/store.ts:518-523`).
  - `countColdMemories` / `countMemoryPromotions`: cold-tier counts (`packages/memory-core/src/store.ts:529-538`).
  - `listMemoryMisses`: queries recent search misses (`packages/memory-core/src/store.ts:539-548`).
  - `coreShelf`: queries active core conventions for prompts (`packages/memory-core/src/store.ts:252-258`).
  - `pendingVectors`: queries active records missing vector embeddings (`packages/memory-core/src/vectors.ts:41-48`).
  - `activeMemoryDigestRows`: retrieves active notes sorted by acceptance for cards (`packages/memory-core/src/store.ts:612-618`).
  - `memoryFillRows` / `memoryHiddenRows`: calculates shelf fill and hidden counts by status (`packages/memory-core/src/store.ts:415-419, 429-431`).
  - `firstUnusedCoreRecordId`: finds oldest unaccepted maintainer core record (`packages/memory-core/src/store.ts:434-439`).
  - `memoryRecordExists`: verifies whether record exists in project (`packages/memory-core/src/store.ts:618-635`).

## Table: `lane_pilot_memory_receipt`

Purpose: records an audit log of memory IDs retrieved and delivered to roles during session spawning (`packages/memory-core/src/lifecycle.ts:100-105`).

| Field | Meaning | Allowed values and source | Units / Format | Evidence |
|---|---|---|---|---|
| `id` | Receipt record ID | Format `mr_<now>_<role>_<packedIds>` | String | `packages/memory-core/src/lifecycle.ts:103` |
| `project_id` | Project identifier | Non-empty project string | String | `packages/memory-core/src/lifecycle.ts:101, 104` |
| `role` | Recipient agent role | `"pm"`, `"writer"`, `"critic"`, `"helper"` | String | `packages/memory-core/src/lifecycle.ts:100, 103` |
| `returned_ids` | Search result candidate IDs | JSON array of record ID strings | JSON string | `packages/memory-core/src/lifecycle.ts:104` |
| `packed_ids` | IDs included within token budget | JSON array of record ID strings | JSON string | `packages/memory-core/src/lifecycle.ts:104` |
| `tokens` | Total estimated tokens packed | Non-negative integer (bytes / 4) | Tokens | `packages/memory-core/src/lifecycle.ts:104` |
| `created_at` | Timestamp recorded in `recordMemoryReceipt` (`packages/memory-core/src/lifecycle.ts:100-105`) | Milliseconds since Unix epoch | Epoch ms | `packages/memory-core/src/lifecycle.ts:103` |

### Writers and readers

- Writers: `recordMemoryReceipt` writes a new row each time an agent context is packed (`packages/memory-core/src/lifecycle.ts:100-105`, `src/rooms/writer/server/spawn.ts:3`).
- Readers: audit scripts and test suites inspecting delivered IDs and token consumption (`scripts/lp-wall-morning.sql:106`, `tests/server/memory-receipt.test.ts:10`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core data model](../data-model.md)
