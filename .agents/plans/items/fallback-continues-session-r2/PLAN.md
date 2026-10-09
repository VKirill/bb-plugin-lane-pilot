# A fallback writer continues the interrupted session instead of starting over (restart: previous dispatch hung in a gemini pm-read stage)

## Owner's requirement (2026-10-09)
When a writer's model runs out of quota (or any provider/limit failure moves the task down the writer chain), the next model in the chain must pick up the interrupted session and continue from where it stopped — like BB's «continue in a new chat» handoff — not redo the task from zero.

## Today (src/rooms/writer/server/start.ts ~L596–740)
On class `limit`/`provider` the chain loop creates a new attempt and calls `services.spawnWriterAttempt` with the same contract and plan only. The fallback writer gets no record of what the first writer did; the workspace may be fresh (see `fallbackWorkspace===baselineWorkspacePath`).

## Change
1. Same workspace: the fallback attempt runs in the interrupted attempt's worktree, keeping its uncommitted edits (no rollback in worktree mode; `rollbackLive` stays for live-folder mode). Dirt baseline stays the original attempt's.
2. Handoff brief (new module src/rooms/writer/server/writer-handoff.ts), bounded ≤ ~12k chars, from the interrupted writer thread's BB events and the workspace: previous writer's last assistant messages (newest first, trimmed), files it changed (fileChange items), commands with exit status and a short tail of the last failing one, the last feedback turn it got, `git status --short` + `git diff --stat`, the stop reason, and the instruction «You are continuing an interrupted session of this task. The edits listed are already in the workspace. Do not start over; review them, finish the remaining work, run the checks, end with your summary.» If BB's thread API supports a cross-provider fork/handoff carrying the transcript (check `bb.sdk.threads` and the «Continue from @thread:<id>» convention in src/rooms/native-agent/native-dispatch.ts), use it with the brief as first message; else the brief alone. Mirror line: «Fallback writer … continues @thread:<old>».
3. Fallback budget, cancel and missing-expected_outputs guards unchanged; non-provider failures still do not start the chain.

## Tests
- tests/writer-fallbacks.test.ts: limit failure → fallback spawned with the interrupted workspace path and original dirt baseline; no rollback in worktree mode; task-class failure → no chain.
- tests/writer-handoff.test.ts: fixture events + git status → bounded brief with changed files, failing command tail, stop reason, continue instruction; truncated to the limit.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
