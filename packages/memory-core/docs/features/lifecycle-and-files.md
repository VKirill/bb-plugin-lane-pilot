---
title: Memory lifecycle and file integration
type: component
created: 2026-11-07
updated: 2026-11-13
status: active
confidence: medium
tags: [memory, lifecycle, files, import, export, fingerprint, drift]
sources:
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/files.ts
  - packages/memory-core/src/fingerprint.ts
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/settings.ts
  - src/rooms/memory/server/attempt-effects.ts
  - src/rooms/memory/server/session-memory.ts
  - src/rooms/memory/server/memory.ts
  - packages/memory-core/src/context-pack.ts
  - packages/memory-core/src/compress.ts
  - packages/memory-core/src/lint.ts
---

# Memory lifecycle and file integration

TL;DR: Memory lifecycle manages quarantine, expiration, check refutation, usefulness, corpus review, reversible note shortening, file drift, and YAML memory files.

## Purpose

The lifecycle and file integration subsystem tracks facts over time, expires outdated or idle notes, manages corroboration quarantines, records retrieval feedback, verifies file drift against git checkouts, and converts records between SQLite rows and repository `.agents/memory/<id>.md` markdown files (`packages/memory-core/src/lifecycle.ts:4-47`, `packages/memory-core/src/fingerprint.ts:10-29`, `packages/memory-core/src/files.ts:4-32`).

## How it works

1. Observed quarantine: facts written with `trust = 'observed'` (by a single session or containing hedged phrasing checked via `claimIsHedged` in `packages/memory-core/src/store.ts:117-125`) are held in quarantine for 24 hours (`OBSERVED_QUARANTINE_MS` in `packages/memory-core/src/lifecycle.ts:5`). During this period, they are excluded from regular searches unless confirmed through `corroborate` (`packages/memory-core/src/store.ts:142-143, 153, 231-240`) or queried with `includeObserved` (`packages/memory-core/src/store.ts:289-295, 314-315`).
2. Corroboration: when a second source with a different `sourceSha256` writes an identical fact, the row is added to `corroborate` (`packages/memory-core/src/store.ts:142-143, 153`) and its `verification_json` updated (`packages/memory-core/src/store.ts:231-240`).
3. Idle expiration: notes that are not mixed into any session brief for 90 days (`NOTE_IDLE_MS` in `packages/memory-core/src/lifecycle.ts:7`) are marked as expired with `expired_reason = 'idle'` (`packages/memory-core/src/lifecycle.ts:37-41`). Core records, rules, and file imports are protected by `idleSql` (`packages/memory-core/src/lifecycle.ts:44-46`).
4. Dated expiration: any record with a `valid_until` timestamp that has passed is marked expired with `expired_reason = 'dated'` (`packages/memory-core/src/lifecycle.ts:38-41`).
5. Check refutation: `noteRefutedByCheck` (`packages/memory-core/src/lifecycle.ts:13-18`) compares a failed test or check output against note content. If the failure text quotes 40 or more continuous characters of the note, the note is marked expired with `expired_reason = 'refuted'` (`src/rooms/memory/server/attempt-effects.ts:13`, `packages/memory-core/src/lifecycle.ts:31-34`).
6. Usefulness metrics: each time a record is mixed into a brief, `recordMemoryMixed` increments `use_count` and updates `last_used_at` (`packages/memory-core/src/lifecycle.ts:94-97`). When the attempt is accepted, `recordMemoryAccepted` increments `accepted_count` (`packages/memory-core/src/lifecycle.ts:114-117`). `memoryUsefulness` calculates the smoothed ratio $(\text{acceptedCount} + 1) / (\text{useCount} + 2)$, capped at 1.5 (`packages/memory-core/src/lifecycle.ts:87-91`).
7. File fingerprinting and drift:
   - `pathsNamed` extracts repository file paths referenced in note content (`packages/memory-core/src/fingerprint.ts:6-8`).
   - `fileFingerprint` hashes sorted file paths and their byte contents, recording whether each file is present or missing (`packages/memory-core/src/fingerprint.ts:14-23`).
   - `filesDrifted` (`packages/memory-core/src/fingerprint.ts:26-29`) re-reads current disk contents and compares the resulting hash against stored hashes; if drifted, context packing marks the candidate as `stale` (`packages/memory-core/src/context-pack.ts:35`).
8. Parsing memory files: `parseLaneMemoryFile` (`packages/memory-core/src/files.ts:46-92`) parses schema-2 front matter into `LaneMemoryFile` (`packages/memory-core/src/files.ts:8-20`). `laneMemoryFileToCandidate` (`packages/memory-core/src/files.ts:97-107`) maps files to candidates, resolving `audienceForSensitivity` (`packages/memory-core/src/files.ts:25-28`) and combining claim and body.
9. Rendering memory files: `renderLaneMemoryFile` serializes a `MemoryRecord` back to schema-2 markdown, mapping kind to `context_priority` and generating a deterministic file name via `exportedFileName` (`packages/memory-core/src/files.ts:110-152`).
10. Corpus review: `reviewMemory` reads active records and proposes same-subject note supersessions plus idle or dated expirations; it does not write the proposals (`packages/memory-core/src/lint.ts:116-142`).
11. Note shortening: the [context packing helpers](context-packing.md) propose shorter wording; `applyShorter` stores an accepted shorter note as its replacement, and `undoShorter` reactivates the predecessor (`packages/memory-core/src/compress.ts:116-166`).

## Modes, variants and branches

| Trust / Expiry variant | Conditions and inputs | Lifecycle behavior | Effect on retrieval | Evidence |
|---|---|---|---|---|
| Confirmed trust | Authoritative source, rule origin, or 2+ independent sources | Immediately visible to all readers | Searchable immediately | `packages/memory-core/src/store.ts:123`, `packages/memory-core/src/store.ts:314-315` |
| Observed trust | Single session or uncorroborated import | Quarantined for 24 hours (`OBSERVED_QUARANTINE_MS`) | Hidden from regular search; visible only with `includeObserved` | `packages/memory-core/src/lifecycle.ts:5`, `packages/memory-core/src/store.ts:289-295, 314-315` |
| Idle expiration | Note unused for `NOTE_IDLE_MS` (`packages/memory-core/src/lifecycle.ts:7`) via `idleSql` (`packages/memory-core/src/lifecycle.ts:44-46`) | Status changed to `'expired'` by `hideRecord` (`packages/memory-core/src/lifecycle.ts:30-34`) | Excluded from search | Unindexed from search tables |
| Dated expiration | `valid_until <= now` | Status changed to `'expired'`; reason `'dated'` | Purged from FTS5 and trigram indexes | `packages/memory-core/src/lifecycle.ts:38-41` |
| Revoked or archived | Owner withdrawal or archival | Stored as `expired_reason` | Revoked rows do not revive from restatement; archived notes are eligible for cold-tier retrieval | `packages/memory-core/src/lifecycle.ts:9-10`, `packages/memory-core/src/store.ts:157-160, 499-513` |
| Owner forget tombstone | `memory forget --expire` or `--replace` marks the record `expired_reason = 'owner'` | A matching restatement or file re-import does not revive it | Remains expired and is excluded from retrieval | `packages/memory-core/src/lifecycle.ts:9-10`, `packages/memory-core/src/store.ts:154-160` |
| Check refutation | Check failure output contains 40 chars of note text | Tested by `noteRefutedByCheck` (`packages/memory-core/src/lifecycle.ts:12-17`) | Marked expired | Reason set to `'refuted'` |
| Sensitivity mapping | `public` -> `export`; `internal` -> `subagent`; `sensitive` / `encrypted-required` -> `owner` | Maps YAML front matter sensitivity to memory audience | Enforces audience filtering in store | `packages/memory-core/src/files.ts:22-27` |
| Corpus review proposal | Active note pairs share a subject, or a note is idle / past `valid_until` | `reviewMemory` | Returns sorted `supersede` or `expire` proposals without changing rows | `packages/memory-core/src/lint.ts:123-142` |
| Shortening | Note row; proposed text must be non-empty and shorter by token estimate | `applyShorter` / `undoShorter` | Replaces the note and records a `compress` verification mark, or restores the predecessor | `packages/memory-core/src/compress.ts:116-166` |

## Failure behavior

| Failure condition | Handling mechanism | Outcome | Evidence |
|---|---|---|---|
| Missing front matter in file | `parseLaneMemoryFile` checks for leading `---` and closing delimiter | Returns `null`; import skips file | `packages/memory-core/src/files.ts:47-49` |
| Missing ID in file front matter | `top.id` validation in `parseLaneMemoryFile` | Returns `null`; file is not imported | `packages/memory-core/src/files.ts:78-79` |
| Inactive status in file | `laneMemoryFileToCandidate` checks `file.status !== 'active'` | Returns `null`; candidate is dropped | `packages/memory-core/src/files.ts:98` |
| Expired file date | `file.validUntil < now` in `laneMemoryFileToCandidate` | Returns `null`; candidate is dropped | `packages/memory-core/src/files.ts:99` |
| Missing file during fingerprinting | `fileFingerprint` (`packages/memory-core/src/fingerprint.ts:14-23`) encounters `bytes === null` | Hashes `\0missing` sentinel | Distinct from empty bytes |
| Ambiguous note ID prefix | Prefix names more than one active note | `resolveCompressible` | Returns an error asking for a longer prefix | `packages/memory-core/src/compress.ts:94-103` |
| Shortening proposal is unchanged or not shorter | Empty, identical, or not fewer estimated tokens | `applyShorter` | Throws; no replacement is written | `packages/memory-core/src/compress.ts:116-121` |

## Business rules

- Twenty-four hour quarantine: observed facts require 24 hours or a corroborating second source before being injected into working agent prompts (`packages/memory-core/src/lifecycle.ts:5`, `packages/memory-core/src/store.ts:315`).
- Ninety-day idle cutoff: notes not utilized for `NOTE_IDLE_MS` (`packages/memory-core/src/lifecycle.ts:7`) are expired; core records, rules, and imports are protected by `idleSql` (`packages/memory-core/src/lifecycle.ts:45-47`).
- Refutation threshold: check output must match at least 40 continuous characters of a note to confirm refutation; generic error messages do not refute facts (`packages/memory-core/src/lifecycle.ts:14-16`).
- File content cap: imported markdown claims and bodies are capped at 4,000 characters (`packages/memory-core/src/files.ts:94, 100`).
- Usefulness smoothing: usefulness formula $(\text{acceptedCount} + 1) / (\text{useCount} + 2)$ starts at neutral 0.5 and is bounded at 1.5 (`packages/memory-core/src/lifecycle.ts:88-92`).
- Critic separation: reviewer and critic usage increments `critic_count` rather than `use_count`, preventing reviewer lookups from altering usefulness scores (`packages/memory-core/src/lifecycle.ts:108-112`).
- Corpus review is advisory: `reviewMemory` returns proposals and performs no writes (`packages/memory-core/src/lint.ts:118-123`, `packages/memory-core/src/lint.ts:137-141`).
- A shortened note retains its origin, task ID, source file link, and validity dates; its compression verification mark prevents re-import from restoring the old wording (`packages/memory-core/src/compress.ts:127-145`).
- Expired records marked `owner` or `revoked` do not revive by restatement or file re-import. Archived records also do not revive through those paths; only archived notes enter the cold-tier read (`packages/memory-core/src/store.ts:154-160, 499-513`).

## Public API or commands

- `hideRecord(db, projectId, id, status, supersededBy, unindex, expiredReason?)`: updates record status to superseded or expired and deletes it from search indexes (`packages/memory-core/src/lifecycle.ts:31-35`).
- `expireMemory(db, projectId, personalBot, now, unindex)`: scans and expires dated and 90-day idle records (`packages/memory-core/src/lifecycle.ts:38-42`).
- `noteRefutedByCheck(content, failureText)`: tests if failure output refutes a note (`packages/memory-core/src/lifecycle.ts:12-17`).
- `retireStaleCuratorClaims(db, projectId, unindex)`: expires outdated records claiming nightly memory curator is active (`packages/memory-core/src/lifecycle.ts:23-28`).
- `sameSubject(a, b)`: checks if two notes share >= 2 tags and have Jaccard or Dice overlap >= 0.3 (`packages/memory-core/src/lifecycle.ts:76-82`).
- `memoryUsefulness(record)`: calculates smoothed utility score (`packages/memory-core/src/lifecycle.ts:88-92`).
- `recordMemoryMixed(db, projectId, ids, now?)`: records brief usage for an array of record IDs (`packages/memory-core/src/lifecycle.ts:94-98`).
- `recordMemoryReceipt(db, input)`: inserts retrieval receipt into `lane_pilot_memory_receipt` (`packages/memory-core/src/lifecycle.ts:100-106`).
- `listMemoryReceipts(db, projectId?, limit?)`: reads newest receipts globally or for one project, clamping the limit to 1–500 rows (`packages/memory-core/src/lifecycle.ts:130-153`).
- `recordMemoryAccepted(db, projectId, ids)`: increments accepted attempt counter (`packages/memory-core/src/lifecycle.ts:114-118`).
- `recordCriticUse(db, projectId, ids)`: increments critic usage counter (`packages/memory-core/src/lifecycle.ts:108-112`).
- `reviewMemory(db, projectId?, now?)`: returns sorted same-subject, idle, and dated review proposals without mutating the corpus (`packages/memory-core/src/lint.ts:123-142`).
- `applyShorter(db, row, text, now?)` / `undoShorter(db, projectId, newId)`: replace a note with shorter text and restore its predecessor (`packages/memory-core/src/compress.ts:116-166`).
- `pathsNamed(text)`: extracts repository file paths from text (`packages/memory-core/src/fingerprint.ts:6-8`).
- `fileFingerprint(parts)`: computes SHA-256 fingerprint of named files (`packages/memory-core/src/fingerprint.ts:14-23`).
- `filesDrifted(stored, paths, read)`: evaluates whether files have drifted from stored hash (`packages/memory-core/src/fingerprint.ts:26-29`).
- `parseLaneMemoryFile(text)`: parses schema-2 YAML front matter (`packages/memory-core/src/files.ts:46-92`).
- `laneMemoryFileToCandidate(file, now?)`: maps parsed file to candidate record (`packages/memory-core/src/files.ts:97-107`).
- `renderLaneMemoryFile(record, audience, exportedAt?)`: renders record to schema-2 markdown (`packages/memory-core/src/files.ts:119-152`).
- `exportedFileName(record)`: generates `lp-<id16>.md` file name (`packages/memory-core/src/files.ts:110-112`).

## Gotchas

- Unindexing is mandatory when hiding records: `hideRecord` (`packages/memory-core/src/lifecycle.ts:30-34`) requires an `unindex` callback like `dropMemoryIndexes` (`packages/memory-core/src/store.ts:78-81`) to purge search tables.
- A missing file produces `\0missing` in `fileFingerprint` (`packages/memory-core/src/fingerprint.ts:14-23`), meaning that deleting a referenced file causes the candidate note to be marked `stale` (`packages/memory-core/src/context-pack.ts:35`).
- Exported file claims are truncated to 200 characters with ellipsis if the first line is long, placing the remainder in the markdown body (`packages/memory-core/src/files.ts:120-122`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory context packing](context-packing.md)
- [Memory core workspace overview](../overview.md)
