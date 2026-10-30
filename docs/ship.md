---
title: Ship after acceptance
type: component
created: 2026-10-30
updated: 2026-10-30
status: active
confidence: medium
tags: [ship, deploy, pm, merge]
sources:
  - src/rooms/native-agent/native-agent-overlay.ts
  - scripts/lp-ship.ts
---

# Ship after acceptance

TL;DR: once every task in the batch is accepted and merged into main, the PM ships without asking: push, bring the project up the way it already runs, prove it live. The rule lives in the PM session prompt (`src/rooms/native-agent/native-agent-overlay.ts:212-221`); this page is its docs-side record.

## How it works

1. **Push** — `git push origin <branch>` from the project checkout (normally main). A rejected push means origin moved: fetch, report the diff, dispatch a writer to integrate, push again. The guard refuses a force-push.
2. **Bring it up** — the project's own deploy or start command: `PROJECT.md`, `README.md`, package scripts, `scripts/deploy.sh`, docker compose or a systemd unit, `sudo -n` where needed. If the project has no way to run it, the PM says so instead of inventing one.
3. **Prove it live** — a healthcheck, a request to the changed route, `systemctl is-active`, or the service log after restart.

The PM reports each command, its exit code and the live check. On failure: read the error, retry, or dispatch a writer for the fix; ask the human only after recovery is exhausted, or for a missing secret, money, or irreversible data. `scripts/lp-ship.ts` is the helper the report tooling uses.

## Limits

- Shipping is a PM duty, not a graph stage: nothing in `workflows/` runs a deploy; acceptance ends at merge, ship starts after.
- A project with no runnable deploy path gets a push plus an explicit "no way to run it" — never a fabricated check.
