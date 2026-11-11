---
title: "Cohort measurement and anomaly diagnosis"
status: draft
owner: drmax-books-finish
target_skill: seo-update-forensics
source_pages: "Доказательное SEO 2026, book 1 ch.1 pp.18–23; book 2 ch.7 pp.405–420"
tags: [seo, engineering-reference, synthesized, private]
---

# Cohort measurement and anomaly diagnosis

> [!IMPORTANT] Scope
> This is an independently worded engineering synthesis of the local book, not a reproduction. Source interpretations of Google internals are hypotheses, not exposed metrics or proof of current ranking behavior. Examples and numerical settings are not universal rules. Operational checks added by the compiler are identified below.

## Intake contract

Require raw dated exports and metric definitions. Preserve query, URL, device, country, search type and collection scope where available. A missing query row is not zero demand; aggregation and anonymization can limit coverage. Keep a source identifier on every derived table.

## Diagnose before changing content

1. Check data freshness, incomplete days, timezone, event changes, property filters and release history. Reconcile GA4 and GSC by their different measurement roles rather than demanding identical counts.
2. Locate the affected contour: query family, page role, template, device, geography or the entire site. Compare aligned weekdays and seasonal context; separate branded and unbranded demand.
3. Recompute ratios from counts. `CTR = clicks / impressions`; never add CTRs. Compare position buckets and query mix, since an aggregate average position can hide a composition shift.
4. Distinguish demand contraction, visibility/ranking loss, SERP click capture and measurement failure. Check dated SERP evidence for features or competitor changes instead of inventing a current SERP from model memory.
5. Attach competing explanations and the next observation that can discriminate them. Route crawl/index defects to technical diagnosis; route verified content/intent gaps to refresh; route unresolved telemetry to measurement repair.

## Forecasting and alert limits

The source assigns numerical anomaly detection to statistical models and interpretation to the LLM. Supply the historical series, event calendar and assumptions. The compiler adds rolling-origin backtests, comparison with a seasonal naive forecast, interval-coverage checks and MAE reporting. Avoid MAPE with zero actual values. Do not let a language model produce a precise forecast without a computed numerical result.

An alert threshold is local to the metric's variance, business materiality and reporting lag. Do not turn an example percentage from the book into a global alarm rule. Correlation with an update date does not establish the cause.

## Artifact and gate

Return an anomaly card with observed deltas, source windows, affected cohort, data-quality verdict, candidate mechanisms, counterevidence and next check. A definitive cause requires supporting observations beyond the alert. If uncertainty remains, preserve it and schedule a dated follow-up.

## Source and integration

Source: Доказательное SEO 2026, book 1 ch.1 pp.18–23; book 2 ch.7 pp.405–420. Resolve physical PDF page N to `/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/raw_pages/page_NNN.txt`. Cross-check the named procedures in [the registry](/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/procedures-registry.json). This reference is ready for review and placement in `seo-update-forensics`; no skill installation or live changes were performed.
