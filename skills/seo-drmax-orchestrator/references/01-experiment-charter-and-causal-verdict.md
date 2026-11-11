---
title: "Controlled SEO experiments and factor verification"
status: draft
owner: drmax-books-finish
target_skill: seo-measurement-loop
source_pages: "Доказательное SEO 2026, book 2 ch.5 pp.390–397; ch.7 pp.420–425"
tags: [seo, engineering-reference, synthesized, private]
---

# Controlled SEO experiments and factor verification

> [!IMPORTANT] Scope
> This is an independently worded engineering synthesis of the local book, not a reproduction. Source interpretations of Google internals are hypotheses, not exposed metrics or proof of current ranking behavior. Examples and numerical settings are not universal rules. Operational checks added by the compiler are identified below.

## Trigger and inputs

Use before attributing a change in traffic, rank or conversions to a ranking factor or prompt revision. Collect dated page/query cohorts, prompt/model versions, the change calendar, business KPI definitions and an unaffected comparison group. Record missing data explicitly.

## Procedure

1. Define a falsifiable claim: changing X on cohort T should change primary outcome Y relative to C. Choose the assignment unit, business minimum useful effect, exclusions and stopping rule before exposure.
2. Verify stable pre-change trends, page roles, device/country/search context and treatment delivery. Keep dependent pages together when internal linking or template changes can contaminate a control.
3. Change one factor. Preserve the assignment and exact release time. Do not vary bot and user content to create an experiment. Record concurrent updates, campaigns and template edits.
4. Compute absolute effects with uncertainty. Inspect treatment and control outcomes together; CTR, ranking and business conversion are separate endpoints. Review a cohort only after its stated data window and reporting lag are satisfied.
5. Return supported, contradicted within the design, or inconclusive. Include alternative explanations, the limits of generalization and the next discriminating observation. Scaling needs a separate release decision.

## Statistical decision contract — compiler addition

The book describes a stable page split, an illustrative 50/50 allocation and observation after 4–6 weeks. It does not supply power calculations, confidence intervals or significance tests. Calendar time alone cannot establish sufficient evidence.

For comparable groups on the same scale:

$$\widehat\Delta=(T_{after}-T_{before})-(C_{after}-C_{before}).$$

Check pre-trends before using this difference-in-differences estimate. For independent binary observations consider a proportions test or Fisher's exact test for sparse counts; for independent continuous group means consider Welch where assumptions fit. URL panels and daily counts are dependent: use a suitable clustered/time-series model, randomization inference or cluster/block bootstrap. A naive test on every daily impression exaggerates sample size.

Predeclare alpha, power and any multiple-comparison correction. Holm can control a confirmatory test family; an exploratory FDR screen must remain exploratory. Use a valid sequential design if continuous decisions are required. An interval spanning useful gain and useful harm means inconclusive, even when a single point estimate looks attractive.

## Output and completion

Save a charter, immutable cohort membership, release receipt, analysis table, effect interval and bounded verdict. Completion requires treatment verification and a valid comparison; an LLM explanation or a chart alone is insufficient.

## Source and integration

Source: Доказательное SEO 2026, book 2 ch.5 pp.390–397; ch.7 pp.420–425. Resolve physical PDF page N to `/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/raw_pages/page_NNN.txt`. Cross-check the named procedures in [the registry](/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/procedures-registry.json). This reference is ready for review and placement in `seo-measurement-loop`; no skill installation or live changes were performed.
