---
title: Ship after acceptance
type: component
created: 2026-10-30
updated: 2026-11-24
status: active
confidence: medium
tags: [ship, deploy, pm, merge]
sources:
  - src/rooms/native-agent/models/native-agent-overlay.ts
  - scripts/lp-ship.ts
---

# Ship after acceptance

TL;DR: once every task in the batch is accepted, merged into main, and its `gate` reads `green on <sha>`, the PM ships without asking: push, bring the project up the way it already runs, prove it live. The rule lives in the PM session prompt (`src/rooms/native-agent/models/native-agent-overlay.ts:254-259`); this page is its docs-side record.

## How it works

1. **Gate check** — before shipping, every task in the batch must be accepted with `gate` reading `green on <sha>` (if `running`, wait; if `red:` or `not run:`, fix or rerun the gate on main first) (`src/rooms/native-agent/models/native-agent-overlay.ts:255`).
2. **Push** — `git push origin <branch>` from the project checkout (normally main). A rejected push means origin moved: fetch, report the diff, dispatch a writer to integrate, push again. The guard refuses a force-push (`src/rooms/native-agent/models/native-agent-overlay.ts:256`).
3. **Bring it up** — the project's own deploy or start command: `PROJECT.md`, `README.md`, package scripts, a deploy script under its `scripts/` folder, docker compose or a systemd unit, `sudo -n` where needed. If the project has no way to run it, the PM says so instead of inventing one (`src/rooms/native-agent/models/native-agent-overlay.ts:257`).
4. **Prove it live** — a healthcheck, a request to the changed route, `systemctl is-active`, or the service log after restart (`src/rooms/native-agent/models/native-agent-overlay.ts:258`).

The PM reports each command, its exit code and the live check; on a project failure, the PM reads the error, retries, or dispatches a writer for the fix (`src/rooms/native-agent/models/native-agent-overlay.ts:259`). `scripts/lp-ship.ts` provides the release-check CLI (`doc-audit`, `publishable`, `lane`, `freshness`) (`scripts/lp-ship.ts:4-20`).

## Limits

- Shipping is a PM duty, not a graph stage: nothing in `workflows/` runs a deploy; acceptance ends at merge, ship starts after.
- A project with no runnable deploy path gets a push plus an explicit "no way to run it" — never a fabricated check.

<!-- lane-pilot:backlinks -->
## Referenced by

- [The task pipeline](flows/task-pipeline.md)
