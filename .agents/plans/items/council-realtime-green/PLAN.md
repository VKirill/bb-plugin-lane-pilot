# Council page realtime test red on main blocks the Lane Pilot deploy

`bb-plugin-push lane-pilot` on main 00cf9bd refused: after a rerun one test stays red — tests/realtime-ui.test.tsx > «the council page follows the server's signals (H6) > shows a new message at once on a council signal for its project»: `Unable to find an element by: [data-testid="council-messages"]`. It is red on ac67cfc too (before fallback-summary-names), so a recent merge from another task broke it. Find the commit with `git log -- src/rooms/council src/rooms/ui-shell tests/realtime-ui.test.tsx` / bisect over today's merges, and fix the cause in the product code (do not weaken the test). If the council page legitimately changed (testid renamed, messages now behind a segment/tab), update the test to the new real structure and say which commit changed it.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
