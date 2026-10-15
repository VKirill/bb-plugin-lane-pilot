Evidence: owner screenshot 2026-10-15 — a CRM PM chat got «results of your tasks» with 1 accepted + 10 canceled lines (tasks the PM itself canceled when handing over), PM replied «nothing to do».

- [x] In relay.ts taskNotices, mark canceled-only transitions reported without sending a notice; collapse canceled results into a count when other results need a notice.
- [x] Update tests/relay-task-notices.test.ts and run verification.
