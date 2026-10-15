Evidence (2026-10-15, owner screenshot): an old CRM PM chat silent for 22+ hours got two self-repair tells («ck-09 accepted, the alarm was false», «for the record (nothing to do now): ck-12-e2e-v2 was not stuck»), each a full PM turn reloading a huge context. Brief step 6 in self-repair.ts (around line 276) always says «Tell the affected PM thread(s) what happened».

Steps:
- [x] Resolve the last user-initiated message time per PM thread and pass it to the brief builder.
- [x] Tell live PMs only when action is needed; keep idle PMs quiet and put their next step in the report.
- [x] Update tests in tests/server/self-repair.test.ts and run verification.
