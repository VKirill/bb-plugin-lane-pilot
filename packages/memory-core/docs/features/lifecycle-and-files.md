---
title: Memory lifecycle and file integration
type: component
created: 2026-11-07
updated: 2026-11-08
status: active
confidence: high
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
---

# Memory lifecycle and file integration

TL;DR: Memory lifecycle manages quarantine, idle expiry, check refutation, usefulness metrics, file drift hashing, and bidirectional YAML front matter conversion.

## Purpose

The lifecycle and file integration subsystem tracks facts over time, expires outdated or idle notes, manages corroboration quarantines, records retrieval feedback, verifies file drift against git checkouts, and converts records between SQLite rows and repository `.agents/memory/<id>.md` markdown files (`packages/memory-core/src/lifecycle.ts:4-47`, `packages/memory-core/src/fingerprint.ts:10-29`, `packages/memory-core/src/files.ts:4-32`).

## How it works

1. Observed quarantine: facts written with `trust = 'observed'` (by a single session or containing hedged phrasing checked via `claimIsHedged` in `packages/memory-core/src/store.ts:117-125`) are held in quarantine for 24 hours (`OBSERVED_QUARANTINE_MS` in `packages/memory-core/src/lifecycle.ts:5`). During this period, they are excluded from regular searches unless confirmed through `corroborate` (`packages/memory-core/src/store.ts:150, 230-234`) or queried with `includeObserved` (`packages/memory-core/src/store.ts:309`).
2. Corroboration: when a second source with a different `sourceSha256` writes an identical fact, the row is added to `corroborate` (`packages/memory-core/src/store.ts:150`) and its `verification_json` updated (`packages/memory-core/src/store.ts:225-234`).
3. Idle expiration: notes that are not mixed into any session brief for 90 days (`NOTE_IDLE_MS` in `packages/memory-core/src/lifecycle.ts:7`) are marked as expired with `expired_reason = 'idle'` (`packages/memory-core/src/lifecycle.ts:37-41`). Core records, rules, and file imports are protected by `idleSql` (`packages/memory-core/src/lifecycle.ts:44-46`).
4. Dated expiration: any record with a `valid_until` timestamp that has passed is marked expired with `expired_reason = 'dated'` (`packages/memory-core/src/lifecycle.ts:38-41`).
5. Check refutation: `noteRefutedByCheck` (`packages/memory-core/src/lifecycle.ts:12-17`) compares a failed test or check output against note content. If the failure text quotes 40 or more continuous characters of the note, the note is marked expired with `expired_reason = 'refuted'` (`src/rooms/memory/server/attempt-effects.ts:12-14`).
6. Usefulness metrics: each time a record is mixed into a brief, `recordMemoryMixed` increments `use_count` and updates `last_used_at` (`packages/memory-core/src/lifecycle.ts:94-97`). When the attempt is accepted, `recordMemoryAccepted` increments `accepted_count` (`packages/memory-core/src/lifecycle.ts:114-117`). `memoryUsefulness` calculates the smoothed ratio $(\text{acceptedCount} + 1) / (\text{useCount} + 2)$, capped at 1.5 (`packages/memory-core/src/lifecycle.ts:87-91`).
7. File fingerprinting and drift:
   - `pathsNamed` extracts repository file paths referenced in note content (`packages/memory-core/src/fingerprint.ts:6-8`).
   - `fileFingerprint` hashes sorted file paths and their byte contents, recording whether each file is present or missing (`packages/memory-core/src/fingerprint.ts:14-23`).
   - `filesDrifted` (`packages/memory-core/src/fingerprint.ts:26-29`) re-reads current disk contents and compares the resulting hash against stored hashes; if drifted, context packing marks the candidate as `stale` (`packages/memory-core/src/context-pack.ts:35`).
8. Parsing memory files: `parseLaneMemoryFile` (`packages/memory-core/src/files.ts:46-92`) parses schema-2 front matter into `LaneMemoryFile` (`packages/memory-core/src/files.ts:8-20`). `laneMemoryFileToCandidate` (`packages/memory-core/src/files.ts:97-107`) maps files to candidates, resolving `audienceForSensitivity` (`packages/memory-core/src/files.ts:25-28`) and combining claim and body.
9. Rendering memory files: `renderLaneMemoryFile` serializes a `MemoryRecord` back to schema-2 markdown, mapping kind to `context_priority` and generating a deterministic file name via `exportedFileName` (`packages/memory-core/src/files.ts:110-152`).

## Modes, variants and branches

| Trust / Expiry variant | Conditions and inputs | Lifecycle behavior | Effect on retrieval | Evidence |
|---|---|---|---|---|
| Confirmed trust | Authoritative source, rule origin, or 2+ independent sources | Immediately visible to all readers | Searchable immediately | `packages/memory-core/src/store.ts:123`, `packages/memory-core/src/store.ts:309` |
| Observed trust | Single session or uncorroborated import | Quarantined for 24 hours (`OBSERVED_QUARANTINE_MS`) | Hidden from regular search; visible only with `includeObserved` | `packages/memory-core/src/lifecycle.ts:5`, `packages/memory-core/src/store.ts:309` |
| Idle expiration | Note unused for `NOTE_IDLE_MS` (`packages/memory-core/src/lifecycle.ts:7`) via `idleSql` (`packages/memory-core/src/lifecycle.ts:44-46`) | Status changed to `'expired'` by `hideRecord` (`packages/memory-core/src/lifecycle.ts:30-34`) | Excluded from search | Unindexed from search tables |
| Dated expiration | `valid_until <= now` | Status changed to `'expired'`; reason `'dated'` | Purged from FTS5 and trigram indexes | `packages/memory-core/src/lifecycle.ts:38-41` |
| Check refutation | Check failure output contains 40 chars of note text | Tested by `noteRefutedByCheck` (`packages/memory-core/src/lifecycle.ts:12-17`) | Marked expired | Reason set to `'refuted'` |
| Sensitivity mapping | `public` -> `export`; `internal` -> `subagent`; `sensitive` / `encrypted-required` -> `owner` | Maps YAML front matter sensitivity to memory audience | Enforces audience filtering in store | `packages/memory-core/src/files.ts:22-27` |

## Failure behavior

| Failure condition | Handling mechanism | Outcome | Evidence |
|---|---|---|---|
| Missing front matter in file | `parseLaneMemoryFile` checks for leading `---` and closing delimiter | Returns `null`; import skips file | `packages/memory-core/src/files.ts:47-49` |
| Missing ID in file front matter | `top.id` validation in `parseLaneMemoryFile` | Returns `null`; file is not imported | `packages/memory-core/src/files.ts:78-79` |
| Inactive status in file | `laneMemoryFileToCandidate` checks `file.status !== 'active'` | Returns `null`; candidate is dropped | `packages/memory-core/src/files.ts:98` |
| Expired file date | `file.validUntil < now` in `laneMemoryFileToCandidate` | Returns `null`; candidate is dropped | `packages/memory-core/src/files.ts:99` |
| Missing file during fingerprinting | `fileFingerprint` (`packages/memory-core/src/fingerprint.ts:14-23`) encounters `bytes === null` | Hashes `\0missing` sentinel | Distinct from empty bytes |

## Business rules

- Twenty-four hour quarantine: observed facts require 24 hours or a corroborating second source before being injected into working agent prompts (`packages/memory-core/src/lifecycle.ts:5`, `packages/memory-core/src/store.ts:309`).
- Ninety-day idle cutoff: notes not utilized for `NOTE_IDLE_MS` (`packages/memory-core/src/lifecycle.ts:7`) are expired; core records, rules, and imports are protected by `idleSql` (`packages/memory-core/src/lifecycle.ts:44-46`).
- Refutation threshold: check output must match at least 40 continuous characters of a note to confirm refutation; generic error messages do not refute facts (`packages/memory-core/src/lifecycle.ts:14-16`).
- File content cap: imported markdown claims and bodies are capped at 4,000 characters (`packages/memory-core/src/files.ts:94, 100`).
- Usefulness smoothing: usefulness formula $(\text{acceptedCount} + 1) / (\text{useCount} + 2)$ starts at neutral 0.5 and is bounded at 1.5 (`packages/memory-core/src/lifecycle.ts:88-90`).
- Critic separation: reviewer and critic usage increments `critic_count` rather than `use_count`, preventing reviewer lookups from altering usefulness scores (`packages/memory-core/src/lifecycle.ts:107-111`).

## Public API or commands

- `hideRecord(db, projectId, id, status, supersededBy, unindex, expiredReason?)`: updates record status to superseded or expired and deletes it from search indexes (`packages/memory-core/src/lifecycle.ts:30-34`).
- `expireMemory(db, projectId, personalBot, now, unindex)`: scans and expires dated and 90-day idle records (`packages/memory-core/src/lifecycle.ts:37-41`).
- `noteRefutedByCheck(content, failureText)`: tests if failure output refutes a note (`packages/memory-core/src/lifecycle.ts:12-17`).
- `retireStaleCuratorClaims(db, projectId, unindex)`: expires outdated records claiming nightly memory curator is active (`packages/memory-core/src/lifecycle.ts:23-28`).
- `sameSubject(a, b)`: checks if two notes share >= 2 tags and have Jaccard or Dice overlap >= 0.3 (`packages/memory-core/src/lifecycle.ts:75-81`).
- `memoryUsefulness(record)`: calculates smoothed utility score (`packages/memory-core/src/lifecycle.ts:87-91`).
- `recordMemoryMixed(db, projectId, ids, now?)`: records brief usage for an array of record IDs (`packages/memory-core/src/lifecycle.ts:94-97`).
- `recordMemoryReceipt(db, input)`: inserts retrieval receipt into `lane_pilot_memory_receipt` (`packages/memory-core/src/lifecycle.ts:100-105`).
- `recordMemoryAccepted(db, projectId, ids)`: increments accepted attempt counter (`packages/memory-core/src/lifecycle.ts:114-117`).
- `recordCriticUse(db, projectId, ids)`: increments critic usage counter (`packages/memory-core/src/lifecycle.ts:108-111`).
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

- [Memory core workspace overview](../overview.md)
