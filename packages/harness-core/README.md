# @lane-pilot/harness-core

The writer harness as an object, and the method that improves it. A port of the core of Harness² (Google Research,
arXiv 2610.14224) without its benchmark runtime; the design and the mapping to Lane Pilot's stages are in
`.bb/chats/thr_xt2vhcuesc/artifacts/harness2-port-design.md`.

| Module | What it holds |
|---|---|
| `tree.ts` | `Tree` (`rel -> content`), the editable surface of a Lane Pilot writer (`always-on.md`, `skills/`, `checks/`, `hooks.json`, `memory.md`), `readTree` / `writeTree`, `validate` (throws every problem at once, as retry feedback), `diffSummary`, `fingerprint`, `inventory` |
| `trajectory.ts` | `renderThreadEvents`: BB thread events in the `[ACTION] / [OBSERVATION] / [ERROR]` grammar an editor cites |
| `experience.ts` | parsers of the editor's `<notes>` (KEEP_BASE), the reflection's `<edits>` rows with verdicts and its single `<experience>` (cue, lesson, evidence, confidence; NO_ENTRY) |
| `prompts.ts` | the editor (INV / DOM), composer and reflection prompts, with Lane Pilot's work and surface |

Nothing here talks to BB, SQLite or a model: the room that runs the editor thread, stores trees and runs the trial
is `src/rooms/harness` (phases 1–5 of the design). This package is phase 0.
