---
name: lp-docs
description: "Keep living docs/ honest after code changes. Use when: nightly docs, docs-maintain, обновить документацию, актуализировать ARCHITECTURE; `$ARGUMENTS` exactly info prints the card. SKIP: writing product code (writer), onboarding a repo (project-onboard)."
argument-hint: "[info]"
---

# Docs maintain (lp-docs)

> **Inside a Lane Pilot chat** (`LANE_PILOT_AGENT_TYPE` set / the nightly docs prompt) you are the nightly docs pass: write only the paths the prompt names, do not commit (Lane Pilot checks the pages, builds `index.md` and backlinks, and commits), and finish with the short list of the pages you wrote. Method and page contract come from `docs-methodology`. Report files under `.agents/session-log/`, `docs-init-chain`, `docs-maintain-project`, cron and the model line below are the terminal harness.

## Info

If `$ARGUMENTS` is exactly `info`, print `references/info.md` verbatim (Russian), then stop. Do not start docs-maintain.

## Who

The docs-maintainer row of the Settings table «role → model» (default Codex `gpt-6-luna`, effort high); a project's own `docs.provider` / `docs.model` win. `docs.enabled` is `auto` by default: docs are kept where a folder is worth it. In a Lane Pilot chat the prompt names the model; do not pick one.

Legacy standalone terminal harness only (do not run inside a BB Lane Pilot session, where the `lp.docs-night` graph and `docs-lint` run natively):

```bash
# Legacy standalone terminal harness (outside BB plugin runtime):
docs-maintain-project /path/to/repo
docs-maintain-project /path/to/repo lint
docs-maintain-all --if-hour
```

## Markers (project is Lane Stack)

- `AGENTS.md` (or a legacy `CLAUDE.md`) contains `Claude Lane Stack`, or
- `.agents/routing.profile.yaml`, or
- `.agents/runs/` exists

## Rules

- Root agent instructions live in `AGENTS.md`; `CLAUDE.md` is only the `@AGENTS.md` pointer. A night-docs block or any doc edit to project instructions goes into `AGENTS.md`, never into the pointer.
- First enable: `docs-init-chain` = project-onboard then wiki. Wiki runner refuses a thin passport.
- Night: yesterday git ∩ owns + leftover stubs. Empty → no LLM.
- Archive (`wiki/`, `TODO/`, `.agents/`, legacy `docs/plans/`) is never written. What a finished task did is in its folder `.agents/tasks/<id>/` (`OUTCOME.md`, `lessons.md`): read it by the id the prompt gives, never by listing `.agents/`. Decision drafts in `.agents/decisions/` are published into `docs/decisions.md`.
- Docs only: feature code goes to a writer lane. The runner commits nothing; the night shift or the owner commits.

## Cron

```bash
0 * * * * $HOME/.agents/bin/docs-maintain-all --if-hour >>$HOME/.agents/logs/docs-maintain.log 2>&1
```
