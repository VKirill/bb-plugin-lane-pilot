# Three writer fallback models, visible in the team table

Owner (2026-10-09, screenshot of the «Исполнитель» row): «потерялись настройки для фолбек моделей, выбора 3х штук хотя бы». The two fallback slots still exist (`writer.fallback{1,2}.{provider,model,reasoning_effort}`, src/rooms/writer/writer-fallbacks.ts; UI in WriterDetail, src/rooms/native-agent/ui/team-details.tsx, data-testid writer-fallbacks) but they are only shown in the row's collapsed detail, so the owner could not find them; and there are only two.

## Change
1. Add slot 3: `WRITER_FALLBACK_SLOTS` = [1,2,3], default for slot 3 empty (off) unless a sensible default exists; extend the `save_writer_fallback_selection` slot enum (src/rooms/contracts/rpc-settings.ts, src/rooms/settings/server/rpc/selections.ts) and team-model keys (`[1,2]` → all slots). `writerFallbackChain` uses all three in order, then the PM model as today.
2. Visibility: in the team table's «Исполнитель» row show the fallback chain inline under the model picker (e.g. «Запасные: Sonnet 5.5 → GLM 5.3 Flash → —»), and clicking it opens the detail with the three pickers. Keep the existing detail editing. Russian/English labels via the existing i18n.
3. No change to how the chain runs on failure.

## Tests
- writer-fallbacks tests: slot 3 is read and appended to the chain in order; an empty slot is skipped.
- RPC: saving slot 3 works; slot 4 refused.
- UI test (existing team tests): the writer row shows the inline fallback summary and the detail has three slot pickers.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
