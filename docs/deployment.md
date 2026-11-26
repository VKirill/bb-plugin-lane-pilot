---
title: Build and deploy Lane Pilot
type: deployment
created: 2026-10-10
updated: 2026-11-24
status: active
confidence: medium
tags: [deployment, build, configuration]
sources:
  - package.json
  - .github/workflows/test.yml
  - packages/contracts/package.json
  - packages/handoff/package.json
  - packages/host-calls/package.json
  - packages/i18n/package.json
  - packages/kit/package.json
  - packages/memory-core/package.json
  - packages/models/package.json
  - packages/resilience/package.json
  - packages/settings-catalog/package.json
  - packages/thread-observe/package.json
  - packages/ui-kit/package.json
  - packages/workflow-engine/package.json
  - host.ts
  - server.ts
  - app.tsx
  - scripts/test-full.sh
  - scripts/test-changed.mjs
  - vitest.config.ts
  - src/rooms/contracts/host.ts
  - src/rooms/core/server/core.ts
  - src/rooms/host-worker/opencode-limit.ts
  - src/rooms/stability/server/services/deploy-drain.ts
  - src/rooms/native-install/server/services/native-install-lifecycle.ts
  - src/rooms/storage/database.ts
  - src/rooms/migrations.ts
  - src/rooms/writer/server/services/start.ts
  - packages/models/src/zcode.ts
  - packages/models/src/role-models.ts
  - tests/global-setup.ts
  - tests/setup-jsdom.ts
  - packages/models/src/agent-model.ts
---

# Build and deploy Lane Pilot

TL;DR: Lane Pilot's root package manifest declares its server, host, and app entries and owns the plugin build and check commands (`package.json:10-18`, `:89-104`).

## Build

The package manifest maps BB's server, host-worker, and app bundles to `server.ts`, `host.ts`, and `app.tsx` (`package.json:10-18`). The npm workspace pattern is `packages/*` (`package.json`). `npm run build` invokes `bb plugin build` (`package.json`). The aggregate `check` script runs `npm test`, typecheck, plugin build, and layout tests in sequence (`package.json`). The workspace packages (`contracts`, `workflow-engine`, etc.) declare `main`, `types`, and `exports` entry points without package-local script runners (`packages/contracts/package.json`, `packages/workflow-engine/package.json`).

The server opens plugin SQLite and applies the migration list as part of plugin startup (`src/rooms/storage/database.ts:20-25`, `src/rooms/migrations.ts:1-4`, `server.ts`). The list is positional and append-only under a hash lock; the rule and the lock file are owned by the [data model overview](data-model.md). The plugin uses Node 22.19+, 24, or 26 and BB version `>=0.43.3`; the SDK engine requirement is `>=0.4.104` (`package.json:3-8`).

## Configuration and runtime

BB loads the plugin's server and app from the manifest; the host bundle is the worker-facing implementation (`package.json:8-18`, `host.ts:1-30`). The server registers rooms via `src/rooms/registry.ts` (RPC, reports, tools, CLI, lifecycle subscriptions, and the shared `engine-clock`). Host operations are declared by `hostContract`, and the server binds that contract through BB's host client (`src/rooms/contracts/host.ts`, `src/rooms/core/server/core.ts:48`).

For reload or shutdown, the VK lifecycle handler enables the same drain used by `deploy_drain`, waits for in-flight checkout writes and acceptance checks until the supplied deadline or abort, then stores the outcome in BB KV (`src/rooms/native-install/server/services/native-install-lifecycle.ts`, `src/rooms/stability/server/services/deploy-drain.ts`). The manifest gives the lifecycle drain a 300,000 ms deadline (`package.json`). Calls entering during an active drain wait; the drain expires after 20 minutes if it is not disabled. A clean reload snapshot with `afterDrain` skips redundant startup scans; other starts scan immediately.

Package scripts define local commands: `npm test`, `npm run test:changed`, `npm run typecheck`, `npm run build`, `npm run test:layout`, and `npm run check` (`package.json`). By default, `npm run test:changed` compares dirty files with `HEAD` or a clean branch with its merge base against `main` (`scripts/test-changed.mjs`). `npm run test:changed -- --graph` runs Vitest's changed dependency graph. `scripts/test-full.sh` is the repository wrapper for the full suite (`scripts/test-full.sh`). On `push`, `pull_request`, and `workflow_dispatch`, GitHub Actions runs `npx tsc --noEmit -p .` and `npx vitest run` in the `test` workflow (`.github/workflows/test.yml`; see [Testing and verification](testing.md#continuous-integration)). Test isolation, DOM shims, and run-level temporary-directory cleanup are defined in `vitest.config.ts`, `tests/setup-jsdom.ts`, and `tests/global-setup.ts`.

## Runtime requirements

- A BB server and connected host workers provide thread, provider, storage, RPC and host-call APIs (`package.json:3-18`, `server.ts`).
- Writer checks and workspace operations execute on the selected project host through host calls (`src/rooms/writer/server/services/start.ts`, `src/rooms/contracts/host.ts`).
- OpenCode writers run through BB's opencode2 provider on each host's shared OpenCode v2 service; the host worker calls `probeOpenCodeLimit` against `openCodeServicePath` to read a silent writer's provider limit (`src/rooms/host-worker/opencode-limit.ts`).
- ZCode (BB provider `zcode`, plugin bb-plugin-zcode) runs GLM-5.3-Flash on the Start Plan's free tokens: the model id is `glm-5.3-flash-free` (`packages/models/src/zcode.ts`), and the bridge refuses it with `promo_unavailable` rather than bill the plan. It is a writer candidate (`zcode-flash`) and an option of the role table (`packages/models/src/agent-model.ts`).
- The host entry binds Git integration, writer-check and shim-preparation handlers (`host.ts`).

## Deployment boundary

The root package scripts define plugin build and verification commands but no deploy script (`package.json:86-98`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Development](guide/development.md)
- [Lane Pilot overview](overview.md)
- [Testing and verification](testing.md)
