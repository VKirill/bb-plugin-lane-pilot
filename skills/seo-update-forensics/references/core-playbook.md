# seo-update-forensics — Extended Playbook

## Step 5 — layer checklist (Appendix 1, checks 1-15)

Full per-layer list: [references/appendix-1-checks.md](references/appendix-1-checks.md). Layers: drop confirmation, segmentation, top losers, SERP layout, index/canonical, crawl/access, index bloat, content vs winners, trust, post-click, CWV, architecture, freshness → then checks 14-15: hypothesis cards + pilot.

Decision rules: no shared pattern among top losers → diagnose page by page, no site-wide fixes. One locale/folder/template → document-class problem. Rule out a canonical switch or split signals before blaming quality. Many weak pages → site-wide trust problem. CWV amplifies a problem; it is not the whole explanation. Fix crawl alongside quality — weak crawling slows recovery.

## Step 6 — hypothesis cards and pilot (pp. 47-49, 727)

Each hypothesis gets a card: what dropped, level, suspected defect, fix, confirming metric, evaluation window, affected URLs (10-20 for template hypotheses), why neighbors held, falsification criterion. Score 0-3 on six criteria (pattern, evidence, model alignment, scale, business effect, verifiability; max 18): 0-5 backlog, 6-10 working, 11-14 priority, 15-18 next sprint. Needs ≥3 confident yeses on the 5-question filter. Deploy alone in its window.

Pilot rules (p. 727): 3-5 hypotheses labelled by layer; limited pilot cohort; technical barriers first, architecture/links before prose rewrites; no mass edits before the pilot validates; evaluate over 1-2 subsequent updates before scaling.

## Trust demotion vs technical loss (ch5, pp. 415-417, 422-426)

A trust demotion shows: many thin/duplicate pages, decorative author blocks that changed nothing, YMYL claims without Tier-1 sources, outdated facts in body text, inflated claims, interstitials, weak external entity. Recovery is strictly ordered — main content → YMYL cleanup (410 for doorway clones, purge expired facts) → UI hygiene → transparency → external verification → packaging/markup last. Schema on a shallow page is ignored. Details: `seo-trust-eeat` skill.

## Output contract (to `seo-evidence-contract`)

Per cohort: mechanism label backed by metrics · scope label (local/template/site) · layer-by-layer log (each check documented or ruled out) · 3-5 hypothesis cards with score, URLs, evidence, falsifier · pilot cohort + monitoring plan · explicit noise exclusions.

## Called by

`seo-monitor.route` and `seo-monitor.drop` (start this graph on a drop bucket or finished core update); `seo-drop-diagnosis` nodes `intake`, `mechanism`, `scope`, `layers`, `hypotheses`; `seo-page-refresh.diagnose` (5-stage pipeline). Procedures: `core-update-response`, `gsc-drop-mechanism-classification`, `drop-scope-cohort-audit`, `ranking-pipeline-stage-diagnosis`, `post-update-drop-diagnosis`, `post-update-recovery-pilot`, `seo-hypothesis-card`.
