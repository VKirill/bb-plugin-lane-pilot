# Common rules for the H streams (Lane Pilot, base 0.1.478+ = commit 16116cfb)

You are one SWE-2 programmer stream of a batch. The goal of the batch: a Lane Pilot PM gets unstuck on its own. Today (2026-11-02) a PM told the owner a quarantine «cannot be lifted» although `bb lane-pilot regress-close` exists; the regression note named it but never reached the PM.
Your stream brief says exactly what to build.

## Where you work
- Your git worktree is your cwd (a branch `swe2/<stream>`). Commit on that branch, never push, never touch `main` or another worktree.
- `node_modules` is a symlink to the main checkout; `@lane-pilot/*` packages resolve to the main checkout's `packages/*`. If your
  stream must edit a package under `packages/`, edit it in your worktree and say so in the report (the merge handles it).
- Run only the tests you touch: `npx vitest run tests/<file>.test.ts` (never the whole suite: it takes 15 minutes and other streams
  share the machine). `npx tsc --noEmit -p .` before the final commit.

## How Lane Pilot code is written (read `AGENTS.md` and `docs/` of the thing you touch first)
- Rooms: each feature lives in `src/rooms/<room>/` and is entered through its `index.ts`; tests in `tests/`. Deep imports across
  rooms are refused by `tests/atlas.test.ts` / coverage tests; import from the room's index.
- Migrations are append-only arrays of SQL strings; never edit an existing string, add a new one at the end.
- Owner-facing text (a card, a page, a reason the PM relays) is plain Russian for a non-programmer: no ids, no English jargon.
  Internal reasons (`attempt.reason`, log lines) stay English and machine-readable (`word:detail`).
- Receipts, not narration: every decision your code makes leaves a row or a log line a human can read later.
- Tests: `node:test`/vitest style as the neighbouring test files; one file per feature, fixtures inline; prefer testing the pure
  function over the wiring.
- Do not add dependencies. Do not add settings for values that do not change; a constant with a comment is enough.

## Report (your last message)
1. Tests added, each with the behaviour it pins (one line each).
2. What you changed where (file: what), and a diff stat.
3. Design choices you made where the brief left room, and anything you could not do with the reason.
4. Suspected defects you noticed outside your scope (file:line, one line), not fixed.
5. The commit hash on your branch.
