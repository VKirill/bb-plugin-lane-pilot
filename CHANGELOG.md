# Changelog

## 0.1.13 — 2026-09-26

- **Every native Lane chat is its own run.** A project needs no Lane Pilot setup, and several Lane chats can run in one project; only the legacy PM pipeline keeps one PM per project.
- **Claude Lane is installed once, the standard way.** A machine with Claude Lane (`~/.agents/install.json` plus the `lane-stack` Claude plugin) is used as is and never removed with Lane Pilot. A machine without it gets `claude-lane-stack` cloned to `~/.local/share/claude-lane-stack-installed` at the tested revision and its own `install.sh` run in the real home, with `flock` (Homebrew) and PyYAML/jsonschema added when missing. The staged, ownership-tracked install is gone; existing manifests still disable and remove as before.
- **Lane Pilot repairs Claude Lane itself** on install and whenever it is enabled: it refreshes a Claude plugin cache left behind by a same-version update, trusts the Codex Lane hooks, and registers the OpenCode Lane plugin also in `opencode.jsonc`.
- **Installation starts when Lane Pilot is enabled** in the composer, on the machine the chat will use; a send waits up to 5 s for a running install and reports a failed install with its reason.
- Bundle Claude Lane agents from `a43826b` (Designer prototype/mockup modes, `cocoon-chainsmith` for the SEO specialist) and pin installs to that revision. `scripts/bundle-lane-agents.py` regenerates the bundle and reproduces the previous one exactly.

## 0.1.12 — 2026-09-24 (predeploy candidate; not installed)

- Add native plan critique, run policy, workspace routing, writer/verification receipts, cancellation and restart reconciliation.
- Add night review/fix, specialist/onboarding, project-scoped memory, living docs, controlled Browser QA and fail-closed sandbox stages with native EN/RU settings.
- Expand the source-backed catalog to 366 rows (355 original tuples plus 11 native controls); keep inventory classification distinct from installed acceptance.
- Integrate the reviewed Lane Stack coexistence and guarded install/rollback adapters. Hub delivery and installed acceptance remain pending exact combined review.

## 0.1.11 — 2026-09-23

- Render Diagnostics CLI preview as scrollable JSON after a live SourceCode renderer failure on the hub.
- Keep the missing-credential Jev test independent of a permanently installed host credential file.
- Allow unrelated CAS settings saves through both single and batch RPCs after a native writer selection, while preserving validation of legacy writer groups and other enumerated settings.
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
