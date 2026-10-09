## Now
- PM chats plan task contracts and dispatch writers into isolated BB threads and worktrees; Lane Pilot checks, reviews, and merges accepted changes. Canceled tasks stop their running stage helpers, and blocked tasks can have checks or paths corrected in place while continuing in the same writer thread.
- Runs coordinate parallel work, blocked-thread handoffs and bounded reminders/asks, recovery, and self-repair; retries give writers actionable failure feedback, stop on repeated failures, and handle green-main fixes before redispatch. Provider-limit failures can continue in the interrupted workspace, including silent OpenCode quota failures; helper spawns use best-effort explicit service tiers, and timeout-only integration gate failures get one recheck before escalation.
- Browser QA and specialist agents support product checks and decisions; the Council page has a responsive desktop office floor, an always-on detailed pixel-art scene with walking, seated, talking characters, linked history and replay, and a chat-only layout below 1024 px.
- Project memory, learned rules, documentation maintenance, and project-life snapshots support ongoing work.
- Settings and CLI manage projects, writer and verification settings, enrolled hosts, installs, run health, and diagnostics; the writer row shows a three-slot fallback chain, writers can receive task-relevant picked skills, OpenCode worktrees materialize those skills, and native installs pin the current Lane Stack guard. PM family tools publish flat argument schemas with per-action validation. The standalone Tokens view shows global spend by model and project with date ranges, monthly views, merged context-window variants, provider-correct cache accounting, and estimated API list-price costs.

## Blocked
- None recorded.

## Next
- [ ] Resolve the remaining owner decisions in the harness engineering gaps plan.

## Last verify
- command: Lane Pilot acceptance for 17 tasks in `lprun_3830fb02731046e89c6d9706ca217fd7`
- result: green; all listed tasks accepted and merged (latest task merge `d71d4df`)
- when: 2026-10-09

## Pointers
- Open todos: none (`.agents/todos/INDEX.md`)
- Active plans: `2026-10-05-harness-engineering-gaps.md` — awaiting owner decisions; `2026-10-07-lane-pilot-handoff.md` — §2–§8 open; `items/writer-task-folder/PLAN.md` — dispatched
- Changelog: `.agents/CHANGELOG.md`
