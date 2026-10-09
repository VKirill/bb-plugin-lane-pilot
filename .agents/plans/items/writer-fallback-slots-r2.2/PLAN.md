# Three writer fallback slots, visible in the writer row (contract widened after the writer's question)

Writer's question answered: yes — add the inline summary in `src/rooms/ui-shell/ui/tab-team.tsx` and new i18n keys (ru + en) in `packages/i18n/src/i18n.ts`; both are now owned. Continue from the previous attempt's work if its worktree is offered.

Owner (2026-10-09): fallback model settings «потерялись», wants at least three. The two slots exist (`writer.fallback{1,2}.{provider,model,reasoning_effort}`, src/rooms/writer/writer-fallbacks.ts; UI in WriterDetail, src/rooms/native-agent/ui/team-details.tsx) but are only in the row's collapsed detail.

## Change
1. Slot 3: `WRITER_FALLBACK_SLOTS` = [1,2,3], slot 3 default empty (off); extend `save_writer_fallback_selection` slot enum (src/rooms/contracts/rpc-settings.ts, src/rooms/settings/server/rpc/selections.ts) and team-model keys. `writerFallbackChain` uses all three in order, then the PM model.
2. The «Исполнитель» row (tab-team.tsx) shows the chain inline under the model picker (e.g. «Запасные: Sonnet 5.5 → GLM 5.3 Flash → —»); clicking opens the detail with three pickers. New labels in packages/i18n/src/i18n.ts (ru + en).
3. No change to failure handling.

## Tests
writer-fallbacks tests: slot 3 read and appended in order, empty slot skipped; RPC slot 3 saves, slot 4 refused.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
