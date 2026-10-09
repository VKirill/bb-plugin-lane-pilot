# A writer whose provider ran out of quota must end as a provider limit, not sit silent (contract widened again)

Writer's questions answered: (1) yes, declare the host RPC in `src/rooms/contracts/host.ts`; (2) breaker holds until the provider's reset time when known (`packages/resilience/src/breaker.ts`), else the fixed 5-minute cooldown; (3) yes, register the new `openCodeLimitProbe` handler in the `handlers` map of root `host.ts` (now owned). Continue from the previous attempt's work if its worktree is offered.

## Evidence (2026-10-09, Mac mini, acp-opencode writers on router9 / ag/gemini-3.8-flash-*)
- Three writers stopped producing events at 12:48 UTC. `~/.local/share/opencode/log/opencode.log` shows per session `level=ERROR message="stream error" providerID=router9 ... session.id=ses_... error.error="AI_APICallError: [antigravity/gemini-3.8-flash-medium] [429]: ... Individual quota ..."`, then `"... Unavailable (reset after 2h 40m 47s)" data.event=session.retry`. OpenCode retries inside the turn and sends nothing to BB; the thread stays `active`.
- Lane Pilot only saw silence: `sweepWriterSilence` (src/rooms/writer/server/writer-silence.ts, wired in server.ts) nudged after 22 min; the attempt would end as `writer_silent_after_nudge` an hour later; the breaker stayed closed.

## Change
1. Host handler `openCodeLimitProbe` (declared in src/rooms/contracts/host.ts, implemented under src/rooms/host-worker/, registered in root host.ts): given an OpenCode session id and since-time, read a bounded tail (≤2 MB, async I/O, no spawnSync) of `$XDG_DATA_HOME/opencode/log/opencode.log` (default `~/.local/share/opencode/log/opencode.log`) and classify that session's newest ERROR lines: `limit` (429, quota, rate/usage limit, credits, `Unavailable (reset after …)`) with provider/model and reset time, else `none`.
2. Session id = `data.providerThreadId` in the writer thread's BB events; only acp-opencode writers are probed.
3. `sweepWriterSilence`: running acp-opencode attempt silent ≥3 min → probe; on `limit` store the KV end record with a reason starting `writer_provider_limit:` (provider/model, reset), no nudge, one log line. Probe error / `none` → existing nudge logic.
4. finish.ts uses the stored reason when present (else WRITER_SILENT_REASON) → class `limit` → chain.
5. Breaker for that provider/model opens exhausted until the reset time when known.

## Tests
Classifier on evidence lines → limit with model and reset; unrelated / other sessions → none. Silent acp-opencode attempt + limit probe ends after 3 min with `writer_provider_limit:`; classifyFailure → limit. Probe error/none keeps nudge. Breaker with reset stays open until it, else 5-minute cooldown.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
