---
title: The nightly docs pass
type: component
created: 2026-10-30
updated: 2026-10-30
status: active
confidence: medium
tags: [docs, nightly, lint, generated]
sources:
  - src/rooms/docs/server/docs-nightly.ts
  - src/rooms/docs/docs-lint.ts
  - src/rooms/docs/docs.ts
  - workflows/lp.docs-night.json
  - scripts/generate-atlas.ts
  - scripts/generate-enabled-settings.ts
---

# The nightly docs pass

TL;DR: `lp.docs-night` rewrites `docs/`, `README.md` and `PROJECT.md` from the code every night and reverts hand edits; a deterministic lint decides whether the pass lands, and one agent round repairs what fails it. The system that keeps every other page true — this is its own flow page.

## How it works

1. **Scope.** The pass lists the docs pages of the unit (root docs or a workspace's own `docs/`), reads the pages it may write, and diffs the git scope for files touched outside its writable set — those are reverted (`src/rooms/docs/server/docs-nightly.ts:640-651`).
2. **Lint.** `lintDocsPages` (`src/rooms/docs/docs-lint.ts:106-175`) enforces the contract: frontmatter (title/type/created/updated/status/confidence/tags/sources), exactly one H1 matching the title, a `## How it works` section on component and flow pages, a minimum of file:line citations, cited files that exist and cited ranges within the file, links that resolve, no marketing words, no `## Referenced by` (the backlinks builder owns it). `lintCitationClaims` adds the semantic check: an identifier the claim names must appear inside the cited range (`docs-lint.ts`, `lintCitationClaims`).
3. **Blockers.** Only findings on pages this pass wrote (or links to pages it removed) block it (`blockingDocsFindings`, `docs-lint.ts:198`); oversized pages the agent made oversized block, ones already over the limit are reported (`docs-lint.ts:208-215`).
4. **Repair.** With findings, the record moves to `repairing` and the docs agent gets one round (`docs-nightly.ts:686-691`).
5. **Generated pages.** `docs/atlas.md` and `docs/enabled-settings.md` are built by `scripts/generate-atlas.ts` / `scripts/generate-enabled-settings.ts` and pinned by hash markers; `docs/index.md` is built by `buildDocsIndex`.
6. **Role pages.** Projects with docs flows get `docs/audiences/{copy,seo,design}.md` and `docs/capabilities.md` (`src/rooms/docs/docs.ts:237`, `docs-lint.ts:277`) — a project without flows has no `docs/audiences/`, which is why the path is dead in this repo's own docs.

## Limits

- A page over 40 000 bytes is never read by the lint; its split waits for a pass of its own.
- Hand edits under `docs/` are reverted; decisions are recorded as drafts in `.agents/decisions/` and published to `docs/decisions.md`.
- A `docs-maintenance` receipt left `running` by a reload mid-pass is not swept by the orphan-stage closer — it covers only `writer-agent`, `verification` and `acceptance-receipt` (`src/rooms/runs/server/stage-records.ts:121-123`); the next pass resumes or replaces it.
