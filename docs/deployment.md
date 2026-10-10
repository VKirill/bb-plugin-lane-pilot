---
title: Build and deploy Lane Pilot
type: deployment
created: 2026-10-10
updated: 2026-10-10
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
  - vitest.config.ts
  - src/rooms/contracts/host.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/opencode-minimal.ts
  - src/rooms/storage/database.ts
  - src/rooms/writer/server/start.ts
  - tests/global-setup.ts
  - tests/setup-jsdom.ts
---

# Build and deploy Lane Pilot

TL;DR: Lane Pilot is built as a BB plugin from its server, host, and app entry points; this repository does not define a Docker Compose deployment.

## Build

The package manifest maps BB's server, host-worker, and app bundles to `server.ts`, `host.ts`, and `app.tsx` (`package.json:8-18`). Workspaces are `packages/*`; `npm run build` invokes `bb plugin build` (`package.json:39-56`). The aggregate `check` script runs tests, typecheck, plugin build, and layout tests (`package.json:39-50`). The 17 npm package workspaces have no package-specific scripts; the root package owns the repository commands (for example, `packages/contracts/package.json:1-13`, `packages/workflow-engine/package.json:1-14`, `packages/world-sim/package.json:1-15`).

The server opens plugin SQLite and applies the migration list as part of plugin startup (`src/rooms/storage/database.ts:323-327`). The plugin uses Node 22.19+, 24, or 26 and BB version `>=0.43.3`; the SDK engine requirement is `>=0.4.104` (`package.json:3-7`).

## Configuration and runtime

BB loads the plugin's server and app from the manifest; the host bundle is the worker-facing implementation (`package.json:8-18`, `host.ts:1-30`). The server registers RPC, tools, CLI, lifecycle subscriptions, schedules, and static world assets (`server.ts:92-125`). Host operations are declared by `hostContract`, and the server binds that contract through BB's host client (`src/rooms/contracts/host.ts:6-15`, `src/rooms/core/server/core.ts:48-49`).

Package scripts define local commands: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:layout`, and `npm run check` (`package.json:39-50`). `scripts/test-full.sh` is the repository wrapper for the full suite (`scripts/test-full.sh:1-22`). Test isolation, DOM shims, and run-level temporary-directory cleanup are defined in `vitest.config.ts`, `tests/setup-jsdom.ts`, and `tests/global-setup.ts` (`vitest.config.ts:21-33`, `tests/setup-jsdom.ts:16-43`, `tests/global-setup.ts:24-35`).

## Runtime requirements

- A BB server and connected host workers provide thread, provider, storage, RPC and host-call APIs (`package.json:3-18`, `server.ts:55-60`).
- Writer checks and workspace operations execute on the selected project host through host calls (`src/rooms/writer/server/start.ts:1-30`, `src/rooms/contracts/host.ts:11-25`).
- The OpenCode minimal-config contributor needs host preparation and can refuse the helper when that preparation is not ready (`src/rooms/core/server/opencode-minimal.ts:9-20`).

## Deployment boundary

The repository's package scripts define a plugin build but no deploy command, container image, Compose service, or Turbo task (`package.json:39-56`; repository root contains no `compose*.yml`, `Dockerfile`, or `turbo.json`). Deployment is performed by the BB plugin distribution workflow, outside these package scripts.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
