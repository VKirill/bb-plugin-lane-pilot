---
title: Build and deploy Lane Pilot
type: deployment
created: 2026-10-10
updated: 2026-10-14
status: active
confidence: medium
tags: [deployment, build, configuration]
sources:
  - package.json
  - packages/contracts/package.json
  - packages/council/package.json
  - packages/handoff/package.json
  - packages/host-calls/package.json
  - packages/i18n/package.json
  - packages/jev/package.json
  - packages/kit/package.json
  - packages/memory-core/package.json
  - packages/models/package.json
  - packages/pixel-world/package.json
  - packages/resilience/package.json
  - packages/run-insights/package.json
  - packages/settings-catalog/package.json
  - packages/thread-observe/package.json
  - packages/ui-kit/package.json
  - packages/workflow-engine/package.json
  - packages/world-sim/package.json
  - host.ts
  - server.ts
  - app.tsx
  - scripts/test-full.sh
  - scripts/test-changed.mjs
  - vitest.config.ts
  - src/rooms/contracts/host.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/opencode-minimal.ts
  - src/rooms/stability/server/deploy-drain.ts
  - src/rooms/native-install/native-install-lifecycle.ts
  - src/rooms/storage/database.ts
  - src/rooms/writer/server/start.ts
  - tests/global-setup.ts
  - tests/setup-jsdom.ts
---

# Build and deploy Lane Pilot

TL;DR: Lane Pilot's root package manifest declares its server, host, and app entries and owns the plugin build and check commands (`package.json:10-18`, `:86-98`).

## Build

The package manifest maps BB's server, host-worker, and app bundles to `server.ts`, `host.ts`, and `app.tsx` (`package.json:10-18`). The npm workspace pattern is `packages/*` (`package.json:96-98`). `npm run build` invokes `bb plugin build` (`package.json:86-91`). The aggregate `check` script runs `npm test`, typecheck, plugin build, and layout tests in sequence (`package.json:86-95`). These root commands live in the root manifest. The contracts, workflow-engine, and world-sim manifests declare package entry points and no `scripts` key; world-sim also exports its protocol subpath (`packages/contracts/package.json:8-12`, `packages/workflow-engine/package.json:8-13`, `packages/world-sim/package.json:8-14`).

The server opens plugin SQLite and applies the migration list as part of plugin startup (`src/rooms/storage/database.ts:323-327`). The plugin uses Node 22.19+, 24, or 26 and BB version `>=0.43.3`; the SDK engine requirement is `>=0.4.104` (`package.json:3-7`).

## Configuration and runtime

BB loads the plugin's server and app from the manifest; the host bundle is the worker-facing implementation (`package.json:8-18`, `host.ts:1-30`). The server registers RPC, tools, CLI, lifecycle subscriptions, schedules, and static world assets (`server.ts:92-125`). Host operations are declared by `hostContract`, and the server binds that contract through BB's host client (`src/rooms/contracts/host.ts:6-15`, `src/rooms/core/server/core.ts:48-49`).

For reload or shutdown, the VK lifecycle handler enables the same drain used by `deploy_drain`, waits for in-flight checkout writes and acceptance checks until the supplied deadline or abort, then stores the outcome in BB KV (`src/rooms/native-install/native-install-lifecycle.ts:15-20`, `src/rooms/stability/server/deploy-drain.ts:59-79`). The manifest gives the lifecycle drain a 300,000 ms deadline (`package.json:20-25`). Calls entering during an active drain wait; the drain expires after 20 minutes if it is not disabled (`src/rooms/stability/server/deploy-drain.ts:14-25`). A clean reload snapshot with `afterDrain` skips redundant startup scans; other starts scan immediately (`src/rooms/stability/server/deploy-drain.ts:82-89`, `server.ts:174-188`).

Package scripts define local commands: `npm test`, `npm run test:changed`, `npm run typecheck`, `npm run build`, `npm run test:layout`, and `npm run check` (`package.json:86-95`). By default, `npm run test:changed` compares dirty files with `HEAD` or a clean branch with its merge base against `main`. It selects changed tests, tests whose imports or filenames match changed TypeScript source files, and tests owned by a changed package; if none match, it exits successfully and suggests graph mode (`scripts/test-changed.mjs:19-24`, `:31-77`). `npm run test:changed -- --graph` runs Vitest's changed dependency graph; either mode accepts a base ref and writes no full-suite deploy receipt (`scripts/test-changed.mjs:4-9`, `:26-29`). `scripts/test-full.sh` is the repository wrapper for the full suite (`scripts/test-full.sh:1-22`). Test isolation, DOM shims, and run-level temporary-directory cleanup are defined in `vitest.config.ts`, `tests/setup-jsdom.ts`, and `tests/global-setup.ts` (`vitest.config.ts:21-33`, `tests/setup-jsdom.ts:16-43`, `tests/global-setup.ts:24-35`).

## Runtime requirements

- A BB server and connected host workers provide thread, provider, storage, RPC and host-call APIs (`package.json:3-18`, `server.ts:55-60`).
- Writer checks and workspace operations execute on the selected project host through host calls (`src/rooms/writer/server/start.ts:1-30`, `src/rooms/contracts/host.ts:11-25`).
- The OpenCode minimal-config contributor needs host preparation and can refuse the helper when that preparation is not ready (`src/rooms/core/server/opencode-minimal.ts:9-20`).
- The host entry binds Git integration, writer-check, shim-preparation, and OpenCode-preparation handlers (`host.ts:1-30`, `host.ts:78-86`).

## Deployment boundary

The root package scripts define plugin build and verification commands but no deploy script (`package.json:86-98`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
