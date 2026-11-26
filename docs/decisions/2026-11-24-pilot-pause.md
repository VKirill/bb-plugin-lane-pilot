---
title: Lane Pilot is paused until the prune-and-events plan is done
type: decisions
created: 2026-11-24
updated: 2026-11-24
status: active
confidence: high
tags: [operations, pause, scheduling]
sources:
  - .ai-factory/plans/pilot-prune-event-graphs.md
  - src/rooms/runs/server/runs-pause.ts
---

# Lane Pilot is paused until the prune-and-events plan is done

TL;DR: the plugin is disabled on the hub since 2026-11-24 17:24 UTC. Nobody runs `bb plugin enable lane-pilot` before Task 22 of the plan, and then only with the owner's yes.

## Context

The owner asked to stop the pilot completely while it is brought to one form: no schedules, no documentation rewrites, no actions of any kind. Lane Pilot had 58 timers and 3 services; about 20 of them were nightly and weekly experiments that rewrote files in projects (docs-night, docs maintenance, project-life) and created work nobody asked for.

The work that brings it to one form is the plan `.ai-factory/plans/pilot-prune-event-graphs.md` (local to the owner's checkout): delete the experiments, run the remaining periodic work as graphs driven by events and durable deadlines, bring every room to one layout, and design one self-evolution graph.

## Decision

1. Open runs were paused, not cancelled: 8 of the 9 open runs across the projects (3 running, 5 blocked) carry the pause flag. The flag lives in the plugin's key-value store (`src/rooms/runs/server/runs-pause.ts`), so it survives the disable and a reload. The ninth, blocked run `lprun_9644736f…` in a neighbouring project, has no pause flag; it is stopped only by the disable.
2. `bb plugin disable lane-pilot` was run on the hub. `bb plugin list` shows `disabled`; `bb lane-pilot` answers that the plugin is off. No timer or service of the plugin runs.
3. Nobody enables the plugin before Task 22. Task 22 is the only re-enable point and needs the owner's yes.

4. The outside self-repair watchdog on the owner's Mac (launchd `pro.vechkasov.lane-pilot-watchdog`, `~/.lane-pilot/self-repair-watchdog.sh`) is stopped too: it saw the disabled plugin as an outage and opened a self-repair thread every 6 hours (2026-11-24 18:28, 2026-11-25 00:28). It was booted out on 2026-11-25 and its plist parked in `~/Library/LaunchAgents/disabled/`.

The exact run ids of the 8 paused runs were reported in the chat that paused them and are not repeated here. After re-enable they are listed by `bb lane-pilot state` (paused runs show their pause state).

## What is unavailable meanwhile

- The hub memory CLI (`bb lane-pilot memory …`) and every other `bb lane-pilot` command.
- PM chats of the pilot: their tools come from the plugin.
- The pilot's pages and settings in BB.
- Graph runs started by the plugin (`workflow_run`, schedule board, triggers).

Project facts that agents would read from hub memory have to be found in the repositories meanwhile.

## Resume order (Task 22)

1. Release the plugin built by the plan through the deploy script; its drill rolls back on red.
2. With the owner's yes: `bb plugin enable lane-pilot`.
3. Check that `bb plugin list` shows exactly one schedule (the engine clock).
4. Run the restart drill (waits park, the plugin restarts, each fires exactly once), the writer isolation drill and `bb lane-pilot memory-probe` in a drill sandbox.
5. Bring the watchdog back: move the plist back to `~/Library/LaunchAgents/` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pro.vechkasov.lane-pilot-watchdog.plist`.
6. `bb lane-pilot resume <run-id>` one paused run at a time; cancel runs whose task no longer exists in the new code. Decide on `lprun_9644736f…` the same way.

## Consequences

- Nothing in Lane Pilot writes documentation or project files until the plan is done.
- Work that needed the pilot runs by hand in ordinary chats meanwhile.
- Paused runs resume into a changed codebase; that is why they resume one by one.

Remaining risk: someone enables the plugin early from another chat. This record, the plan and the plugin's `disabled` state are the guard; there is no technical lock.
