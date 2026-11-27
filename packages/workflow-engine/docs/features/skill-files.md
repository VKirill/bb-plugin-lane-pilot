---
title: Skill Bundle Files
type: component
created: 2026-11-23
updated: 2026-11-23
status: active
confidence: low
tags: [workflow-engine, skills, storage, cas]
sources:
  - packages/workflow-engine/src/skill-files.ts
  - packages/workflow-engine/src/index.ts
  - packages/workflow-engine/package.json
---
# Skill Bundle Files
TL;DR: Companion skill bundle helpers validate, hash, read, compare-and-swap write, and snapshot-restore `~/.bb/skills/<skillId>` directories with symlink rejection and byte/line budgets.

## Purpose

This capability provides filesystem storage for global companion skill bundles (`SKILL.md` plus `references/*.md`) used by skill-backed workflow evolution (`packages/workflow-engine/src/skill-files.ts:8-14`, `packages/workflow-engine/src/skill-files.ts:173-175`, `packages/workflow-engine/src/index.ts:40`).

## How it works

1. `globalSkillsDir` resolves the global companion skills root at `<home>/.bb/skills` (`packages/workflow-engine/src/skill-files.ts:166-169`).
2. `validateSkillBundleFiles` checks the skill ID, requires at least one file including `SKILL.md`, rejects unsafe paths and duplicates, enforces UTF-8 byte and line limits, and orders `SKILL.md` first followed by lexicographically sorted `references/*.md` files (`packages/workflow-engine/src/skill-files.ts:193-227`).
3. `computeSkillBundleSha256` computes a deterministic bundle digest from sorted `path:sha256(text)` lines (`packages/workflow-engine/src/skill-files.ts:230-232`).
4. `readSkillBundle` checks `lstat` on the root, bundle directory, `SKILL.md`, `references/`, and each non-hidden `.md` file in `references/`, rejecting symlinks and returning the sorted files and `bundleSha256` (`packages/workflow-engine/src/skill-files.ts:54-63`, `packages/workflow-engine/src/skill-files.ts:96-128`, `packages/workflow-engine/src/skill-files.ts:235-246`).
5. `casWriteSkillBundle` validates the bundle, reads the current on-disk state and checks targets for symlinks, verifies `before.bundleSha256 === expectedBundleSha256`, writes each file via an exclusive temp file and `rename`, deletes previously tracked files absent from the new bundle, and removes an empty `references/` directory (`packages/workflow-engine/src/skill-files.ts:65-79`, `packages/workflow-engine/src/skill-files.ts:150-170`, `packages/workflow-engine/src/skill-files.ts:249-276`).
6. `restoreSkillBundleSnapshot` removes the bundle directory when `snapshotFiles` is empty, or restores the validated snapshot while pruning any leftover `.md` files in the bundle root or `references/` (`packages/workflow-engine/src/skill-files.ts:81-94`, `packages/workflow-engine/src/skill-files.ts:279-314`).

## Modes and failures

| Operation or branch | Condition | Result |
|---|---|---|
| `readSkillBundle` | Invalid `skillId` | Throws `Error("invalid skill id: ...")` (`packages/workflow-engine/src/skill-files.ts:236`). |
| `readSkillBundle` | Symlink encountered at root, bundle dir, `SKILL.md`, `references/`, or reference file | Emits `WARN` log if `options.log` is set and rethrows `SymlinkForbiddenError` (`packages/workflow-engine/src/skill-files.ts:54-63`, `packages/workflow-engine/src/skill-files.ts:238-245`). |
| `casWriteSkillBundle` / `restoreSkillBundleSnapshot` | Validation failure or symlink target | Returns `{ status: "invalid", reason }` without modifying files (`packages/workflow-engine/src/skill-files.ts:249-264`, `packages/workflow-engine/src/skill-files.ts:279-302`). |
| `casWriteSkillBundle` | `before.bundleSha256 !== expectedBundleSha256` | Returns `{ status: "conflict", reason }` with `bundle_absent`, `bundle_already_exists`, or `bundle_sha256_mismatch` (`packages/workflow-engine/src/skill-files.ts:267-271`). |
| `restoreSkillBundleSnapshot` | Empty `snapshotFiles` array | Removes `<skillsRoot>/<skillId>` recursively and returns `status: "applied"` with empty `afterFiles` and `afterSha256: null` (`packages/workflow-engine/src/skill-files.ts:305-309`). |

## Business rules

- Skill bundle IDs match `/^[a-z][a-z0-9-]{1,47}$/` (2–48 lowercase letters, digits, or hyphens starting with a letter) (`packages/workflow-engine/src/skill-files.ts:8`).
- Allowed bundle paths are `SKILL.md` and `references/<name>.md` matching `/^(?:SKILL\.md|references\/[a-z0-9][a-z0-9._-]{0,79}\.md)$/i`; paths containing `\`, `..`, or a leading `/` are rejected (`packages/workflow-engine/src/skill-files.ts:9-10`, `packages/workflow-engine/src/skill-files.ts:209-211`).
- `SKILL.md` must have non-empty trimmed text, strictly fewer than `SKILL_MD_MAX_BYTES` (`8,192`) UTF-8 bytes, and at most `SKILL_MD_MAX_LINES` (`500`) lines (`packages/workflow-engine/src/skill-files.ts:11-12`, `packages/workflow-engine/src/skill-files.ts:215-218`).
- Each `references/*.md` file must have non-empty trimmed text and at most `SKILL_REF_MAX_BYTES` (`32,768`) UTF-8 bytes (`packages/workflow-engine/src/skill-files.ts:13`, `packages/workflow-engine/src/skill-files.ts:220-221`).
- Symlinks anywhere in the skills root, bundle directory, or target files are forbidden (`packages/workflow-engine/src/skill-files.ts:54-63`, `packages/workflow-engine/src/skill-files.ts:130-148`).
- `casWriteSkillBundle` deletes only previously read bundle files removed from the new bundle (`pruneLeftovers = false`), whereas `restoreSkillBundleSnapshot` sweeps all leftover `.md` files in the bundle directory and `references/` (`pruneLeftovers = true`) (`packages/workflow-engine/src/skill-files.ts:160-165`, `packages/workflow-engine/src/skill-files.ts:273`, `packages/workflow-engine/src/skill-files.ts:311`).
- Structured diagnostic logs via `options.log` respect `LOG_LEVEL` (default `debug`) and redact known secrets with `redactKnown` (`packages/workflow-engine/src/skill-files.ts:42-48`).

## Public API

| Export | Purpose |
|---|---|
| `SKILL_BUNDLE_ID`, `ALLOWED_SKILL_BUNDLE_FILE`, `SKILL_MD_MAX_BYTES`, `SKILL_MD_MAX_LINES`, `SKILL_REF_MAX_BYTES` | Skill ID, file path, and byte/line budget constants (`packages/workflow-engine/src/skill-files.ts:8-13`). |
| `SkillBundleFile`, `StoredSkillBundleFile`, `SkillBundleReadResult`, `SkillBundleWriteResult`, `SkillFilesOptions` | Input, read, write, and logging option types (`packages/workflow-engine/src/skill-files.ts:15-28`). |
| `globalSkillsDir` | Resolve `~/.bb/skills` (`packages/workflow-engine/src/skill-files.ts:166-169`). |
| `sortSkillBundleFiles`, `validateSkillBundleFiles`, `computeSkillBundleSha256` | Order, validate, and hash skill bundle file sets (`packages/workflow-engine/src/skill-files.ts:193-232`). |
| `readSkillBundle`, `casWriteSkillBundle`, `restoreSkillBundleSnapshot` | Read, CAS-write, and snapshot-restore skill bundles on disk (`packages/workflow-engine/src/skill-files.ts:235-314`). |

## Package shape

`skill-files.ts` is a standalone module re-exported by the package root (`packages/workflow-engine/src/index.ts:40`, `packages/workflow-engine/src/skill-files.ts:1-314`).

## Internal model

On disk, a bundle is a directory `<skillsRoot>/<skillId>` holding `SKILL.md` and an optional `references/` directory of `.md` files. Reads ignore hidden dotfiles (`entry.name.startsWith(".")`) and non-`.md` entries in `references/`, while writes stage each file to a UUID-suffixed temporary file with `flag: "wx"` and `mode: 0o644` before renaming (`packages/workflow-engine/src/skill-files.ts:65-73`, `packages/workflow-engine/src/skill-files.ts:113-121`).

## Dependencies

`skill-files.ts` uses Node `node:crypto`, `node:fs/promises`, `node:os`, `node:path`, and `@lane-pilot/kit` (`redactKnown`, `sha256Hex`) (`packages/workflow-engine/src/skill-files.ts:1-6`).

## Gotchas

- `SKILL_MD_MAX_BYTES` (`8,192`) is a strict upper bound (`>=` fails), while `SKILL_REF_MAX_BYTES` (`32,768`) and `SKILL_MD_MAX_LINES` (`500`) are inclusive limits (`>` fails) (`packages/workflow-engine/src/skill-files.ts:217-221`).
- `readSkillBundle` throws on an invalid `skillId` or symlink, whereas `casWriteSkillBundle` and `restoreSkillBundleSnapshot` return `{ status: "invalid", reason }` for invalid IDs and symlink violations (`packages/workflow-engine/src/skill-files.ts:141-146`, `packages/workflow-engine/src/skill-files.ts:235-245`, `packages/workflow-engine/src/skill-files.ts:256-264`, `packages/workflow-engine/src/skill-files.ts:285-302`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
