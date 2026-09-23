# Changelog

## 0.1.11 — 2026-09-23

- Render Diagnostics CLI preview as scrollable JSON after a live SourceCode renderer failure on the hub.
- Keep the missing-credential Jev test independent of a permanently installed host credential file.
- Allow unrelated CAS settings saves after a native writer selection, while preserving validation of legacy writer groups and other enumerated settings.
- Reject cancellation of terminal or closed attempts before stopping a thread; show only legal Monitor actions in mobile and desktop layouts.

## 0.1.0 — 2026-09-23

First public release of Lane Pilot for BB.

- Isolated PM activation (Mode 2) and native BB writer dispatch
- Host worker: detect / install / snapshot / rollback / OpenCode connect / one-shot import
- Settings UI (EN/RU) from the adoc coverage matrix, CAS storage, run monitor
- CLI and BB writer pipelines with task-v2 and acceptance-v2
- Public GitHub, GitNexus index, hub install via the standard path-plugin delivery
- Catalog hygiene: excluded LANE_STACK_ROOT default quotes `~/tools/claude-lane-stack`, not an absolute host path

Based on [VKirill/claude-lane-stack](https://github.com/VKirill/claude-lane-stack) v1.38.0 (`747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821`), MIT.

## 0.0.1-stage0

Internal executable prototype (stations A–C). Not a public GitHub release.
