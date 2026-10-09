# Stage helpers must use the current model settings, not the run's frozen writer

## Problem (2026-10-09, owner report with screenshot)
- After the router9 Gemini quota ran out at ~12:48 UTC, the owner switched the global settings `writer.*` and `pm_read.*` to claude-code / claude-haiku-5-5 (lane_pilot_project_settings, project_id `*`).
- The PM run lprun_3830fb02731046e89c6d9706ca217fd7 started at 10:05 UTC with writer acp-opencode/router9/ag/gemini-3.8-flash-medium.
- At ~14:00 UTC that run spawned a new pm-read stage helper. It still ran on «Antigravity (9router)/Gemini 3.8 Flash», hung, and ended `pm_read_output_empty`.
- Project proj_ejbam66722 has no pm_read.provider/model of its own.

So the pm-read stage ignores the current `pm_read.*` settings and uses the run's config snapshot, the writer model frozen at run start. Writer spawns read `settings["writer.provider"]` live in spawn.ts; stage helpers apparently do not.

A second case: sticky area writers. A follow-up task in the same area went to the existing Gemini writer thread even though writer.* had changed. Decide whether a sticky writer whose provider/model no longer matches the current writer settings should be retired, so a fresh writer takes the task. Implement it if it is cheap and safe; otherwise describe it in the final answer.

## Do
1. Find where the pm-read stage and the other stage helpers (plan critique, code critique, memory, project-life, docs, specialist review) choose provider and model for a run. Start from src/rooms/writer/server/dispatch.ts, start.ts and the pm-read stage runner.
2. Make every stage helper resolve provider, model, effort and tier from the effective settings at spawn time, through `effectiveProjectSettings(projectId, runScopes)` with its own keys (pm_read.*, plan_critique.*, …). Fall back to the run snapshot only when a setting is absent.
3. Test: the run snapshot has model A, the settings later change to model B, and a new pm-read stage spawn gets B.
4. Name the root cause in the final answer (file:line).

## Delivery
- [x] Stage helpers now resolve provider, model, effort, and tier from effective settings at spawn time — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `08cbe1b`.
