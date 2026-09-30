# Changelog

## Unreleased — architecture foundation (branch `arch/foundation`)

- **Packages.** An npm workspace under `packages/` holds code reusable beyond this plugin: `@lane-pilot/thread-observe` (when a child thread is done or failed), `@lane-pilot/memory-core` (guarded project memory over SQLite), `@lane-pilot/handoff` (typed task cards between agents with states, leases and receipts), `@lane-pilot/resilience` (provider circuit breaker, run budgets), `@lane-pilot/run-insights` (writer acceptance per model and risk, lessons from receipts, golden retrieval checks). The map and the rules are in [docs/architecture.md](docs/architecture.md).
- **Handoffs.** PM tools `lane_pilot_handoff_create`, `lane_pilot_handoff_receipt`, `lane_pilot_handoff_list`: a task given to another agent is a card with objective, acceptance, inputs, budget and deadline; it is delivered into a named BB thread or carried to the caller's own subagent, and its receipt closes it. Overdue cards expire every five minutes.
- **Learning loop.** `lane_pilot_lessons_sweep` and a quarter-hourly schedule turn night review findings, rejected acceptances and failed attempts into `subagent` memory notes that the next writer in the same area reads; `lane_pilot_memory_golden` scores retrieval against a golden set; `lane_pilot_routing_stats` shows which provider and model gets tasks accepted at the first try per risk and hints against the configured writer.
- **Writers fail over and stay within budget.** A provider/model that fails repeatedly opens a breaker; the next writer is rejected as unavailable and the existing emergency fallback takes over. A run budget over attempts, wall minutes, tokens and child threads (`bb lane-pilot budget <project> run.max_tokens=...`) blocks new attempts with the exact reason. `lane_pilot_run_health` and `bb lane-pilot health` show both.
- **One memory.** `lane_pilot_memory_import` brings a project's `.agents/memory` records (claude-lane schema 2) into the hub corpus with the audience taken from sensitivity; `lane_pilot_memory_export` writes hub records back as files, so terminal sessions and BB runs read the same memory. The hub corpus is the source of truth.
- **Routing hint in settings.** Under the writer picker the project shows which provider and model got tasks accepted at the first try per risk, against the configured pair.
- **server.ts is an entry point again.** Its 7 000 lines became modules under `src/server/`: a shared core (SDK, storage, host client, settings and section helpers), one factory per area (reconcile, activation, writer run, stages, nightly docs, probes, writer host) and three registration modules (RPC, tools, CLI). Modules call each other through one `Services` interface, so the call graph is explicit and each file can be read on its own. Every move is verbatim; the failing test set is identical to main.
## 0.1.25 — 2026-09-30

- **Parallel lanes never share a checkout.** «В папке проекта» (`adoc.040=in_place`) now runs writers one at a time in that folder, whatever the pool size says; `auto` and `worktree` give every attempt its own git worktree, so 5 or 10 lanes work at once without seeing each other's half-done edits.
- **Checks inside a worktree see the writer's own edits.** `node_modules` is mirrored entry by entry: third-party packages link to the base copy, monorepo workspace packages point back into the worktree, nested `<workspace>/node_modules` are mirrored too, and each workspace package's ignored `dist/` is copied so `exports → dist` resolves. Before, one symlink sent every `@scope/*` import to the base checkout.
- **A merge blocked by uncommitted edits in main is named as such**, with the files, instead of a bare merge failure.

## 0.1.24 — 2026-09-30

- **Ownership is checked per task of a run, not against the union of every task's never_touch.** In a shared in-place checkout a sibling's changes appear in every attempt's diff; a path now passes when some task of the run owns it and does not never_touch it. Before, a sibling listing `apps/**` as never_touch rejected the owner's own files, and the whole run ended blocked.
- **Bookkeeping in the working tree is not the writer's change.** `.agents/**` (memory episodes, PROGRESS.md, design probes, run locks), `.bb/**` chat exports and cache folders that hooks and sibling agents write during an attempt are left out of the ownership check unless the task owns them.
- **A missing read_first path no longer blocks the task.** The packet names the path as absent and the writer is still dispatched; a line window outside a file still fails closed.
- «retry limit 2 exhausted» keeps the reason of the last failed attempt after the colon.

## 0.1.13 — 2026-09-26

- **Every native Lane chat is its own run.** A project needs no Lane Pilot setup, and several Lane chats can run in one project; only the legacy PM pipeline keeps one PM per project.
- **Claude Lane is installed once, the standard way.** A machine with Claude Lane (`~/.agents/install.json` plus the `lane-stack` Claude plugin) is used as is and never removed with Lane Pilot. A machine without it gets `claude-lane-stack` cloned to `~/.local/share/claude-lane-stack-installed` at the tested revision and its own `install.sh` run in the real home, with `flock` (Homebrew) and PyYAML/jsonschema added when missing. The staged, ownership-tracked install is gone; existing manifests still disable and remove as before.
- **Lane Pilot repairs Claude Lane itself** on install and whenever it is enabled: it refreshes a Claude plugin cache left behind by a same-version update, trusts the Codex Lane hooks, and registers the OpenCode Lane plugin also in `opencode.jsonc`.
- **Installation starts when Lane Pilot is enabled** in the composer, on the machine the chat will use; a send waits up to 5 s for a running install and reports a failed install with its reason.
- **Settings inherit: Общие настройки → project → section.** «Общие настройки» is the full settings panel at a level every project and section inherits live; a value set in a project or section overrides it there, and «Вернуть унаследованное» drops back to the level above. Sections from project-folders appear under their project. The global model catalog comes from any connected machine.
- The model picker no longer replaces a saved selection with the catalog's first model (it showed «6-Astra Low») while the settings screen loads.
- Switches for true/false settings (Документы, Память проекта) save again.
- Checked skills, tools and MCP servers of an agent profile are listed first.
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
