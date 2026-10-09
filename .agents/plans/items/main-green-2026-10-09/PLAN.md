# Make main green again after today's merges (deploy gate is red)

`bb-plugin-push lane-pilot` ran the full suite on main (807798e) and refused to deploy: 8 failed files, log /tmp/lp-deploy-tests.log on this machine (excerpts below). Fix each at its cause; do not weaken tests. Several come from today's merged tasks: writer-quota-silence.3 (host.ts, writer-silence, breaker), fallback-continues-session-r2 (writer start/handoff), writer-fallback-slots-r2.2 (writer.fallback3 keys, tab-team.tsx), spawn-tier-best-effort-v3 (service tier), writer-skill-pick-v2 / applicability-skill-pick-row (writer.skill_pick row s474).

Failures:
1. tests/architecture/boundaries.test.ts: new deep imports `entry > writer: 0 -> 1`, `ui-shell > writer: 1 -> 2`, `writer > verification: 0 -> 1`. Import through the room's index files (src/rooms/<room>[/server|/ui]/index.ts, export the name there) — do not update the baseline.
2. tests/ui-runtime.test.ts: `gives every editable row a consumer key` → `s474:writer.skill_pick` has no consumer key; two others expect 231 editable enum rows, got 232. Give writer.skill_pick its runtime consumer entry and bring the expected counts in line with the real catalog (a new row is legitimate; update counts only where the catalog really grew).
3. tests/applicability.test.ts: `{editable: 231}` vs expected 232 — reconcile with the catalog (likely writer.fallback3.* or skill_pick rows).
4. tests/server/architect-start.test.ts and tests/server/self-repair.test.ts: spawn input no longer carries `serviceTier: "explicit"` / `serviceTier: "default"`. Owner rule: helper spawns must send serviceTier "default"/standard explicitly (never fall back to remembered fast). Restore sending it explicitly (best-effort lookup must still not break the spawn).
5. tests/ui-project-nav.test.tsx and tests/ui-six-tabs.test.tsx: time out at 60 s (`findByTestId("scope-rail")`). Find whether a new UI change (fallback summary in tab-team.tsx, new rows) causes a render loop or a hang; fix the cause.

Verify with the listed files only; the gate reruns the full suite.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
