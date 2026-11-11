---
name: seo-measurement-loop
description: "SEO measurement and improvement loop: segmented GSC cohorts, A–D anomaly buckets, hypothesis 0–18 scoring, 12-point task passport, defect-contour fix selection, test-vs-control experiments, SEO Change Log and weekly/monthly/quarterly cadence. Use when: GSC cohorts, anomaly triage, SEO hypothesis, task passport, контрольная группа, Change Log, недельный цикл SEO, бэклог с WIP, измерение эффекта SEO. SKIP: technical defects (→seo-tech-audit-kit); drop forensics after a Google update (→seo-update-forensics); writing the fix itself (→seo-page-templates); backlog file storage (→seo-project-life)."
---

# SEO measurement loop

The closed cycle: measure by cohort → bucket the anomaly → score the hypothesis → write the task passport → pick the fix by defect contour → run a test-vs-control experiment → log it → review on cadence. Source: «SEO Монстр 2027», ch1 pp. 47–51 and ch5 pp. 454–470.

## When

- Setting up monitoring for a project, or a regular audit on a large site
- A scored task or bucketed anomaly needs a concrete fix
- Deploying any template, content or structural change
- Weekly planning, monthly/quarterly reviews

## Backlog storage

The queue, sprint board and task files live in the **seo-project-life** layer (`.agents/seo/<slug>/`). This skill defines the scoring and triage rules; write cards and queues there, do not invent a second backlog.

- Extended methodology & checklists: `references/core-playbook.md`

## Verified Scripts

- `scripts/pulse_02_backtest.py` — deterministic CLI check (`--fixture` / `--input`).
- `scripts/pulse_probe.py` — deterministic CLI check (`--fixture` / `--input`).
- `scripts/pulse_rules.py` — deterministic CLI check (`--fixture` / `--input`).

## Wave-2 Distilled References

- `references/seo-pulse-backtest-probe-alerts.md` — operational playbook and thresholds.
- `references/mature-site-recovery-and-plateau-breakthrough.md` — operational playbook and thresholds.
- `references/02-gsc-cohorts-and-anomaly-forensics.md` — operational playbook and thresholds.
