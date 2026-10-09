# Fallback summary in the writer row: display names, not cut off

Live check on 0.1.212 (Playwright, BB-сервис Team tab, screenshots .bb/chats/thr_eky6yn363y/artifacts/team-writer-row.png, writer-detail-open.png): the Writer row shows «Fallbacks: claude-sonnet-5-5 → zai-coding-plan/glm-5.3-flash → —», cut on screen to «Fallbacks: claude-sonnet-5-5 → zai-co…». The pickers below show display names («Sonnet 5.5 Medium», «Z.AI Coding Plan/GLM-5.3-Flash High»).

Change (src/rooms/ui-shell/ui/tab-team.tsx and whatever helper formats it): use the same display names the model pickers use (short form, e.g. «Sonnet 5.5 → GLM-5.3-Flash»), drop trailing empty slots instead of «→ —», and let the line wrap (or show the full text in a title tooltip) so it is not cut at 1280 or 375 px. Add/adjust a unit test of the summary formatter.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
