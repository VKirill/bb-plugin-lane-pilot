Self-check before you report (the reviewers keep finding these exact classes — check each in your diff and say "checked" per line in the report):
1. A loop over projects / tasks / files / directories / steps: does one failing item (a throw, EACCES, a 500) stop the rest? It must not — per-item boundary, named skip, logged once.
2. A poll or sweep (≤ 1 min period): does a failure log on every tick? Log once per streak/wait.
3. A failed read: does the code then act on an older snapshot, or treat "unknown" as "no / absent / silent / allowed"? Unknown must be its own outcome (wait, park, skip, refuse).
4. A now-propagating error: who catches it — a timer, cron, listener, workflow step? No unhandled rejection; no whole-run failure where a retry/park existed.
5. `git diff main...HEAD -- README.md docs/atlas.md docs/map/index.html` is empty.
6. After every rebase: `node scripts/room-graph.mjs` on main AND on your branch — largestScc/mutualPairs not grown; you did not revert another stream's merged change (diff the files you resolved against main).
7. Paste the literal output of `npx tsc --noEmit; echo "tsc exit=$?"`.
8. No pass-through re-exports; no IO/state in src/rooms/contracts; no duplicate definitions you created.
