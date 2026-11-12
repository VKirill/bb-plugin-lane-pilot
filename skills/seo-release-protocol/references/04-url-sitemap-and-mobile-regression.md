---
title: "URL, sitemap and mobile release invariants"
status: active
owner: drmax-books-finish
target_skill: seo-release-protocol
source_pages: "Доказательное SEO 2026, book 1 ch.3–5 pp.36–88; ch.15 pp.188–200"
tags: [seo, engineering-reference, synthesized, private]
---

# URL, sitemap and mobile release invariants

> [!IMPORTANT] Scope
> This is an independently worded engineering synthesis of the local book, not a reproduction. Source interpretations of Google internals are hypotheses, not exposed metrics or proof of current ranking behavior. Examples and numerical settings are not universal rules. Operational checks added by the compiler are identified below.

## Invariants to preserve

A useful indexable URL has an intended page role, accessible substantive content, consistent canonical signals, a legitimate sitemap entry where appropriate and a usable mobile experience. Stable existing URLs are valuable: cosmetic slug changes alone do not justify migration.

## Review procedure

1. Build a matrix of URL classes and expected behavior: canonical, parameter duplicate, moved, intentionally excluded and missing. For each, record response, robots access, index directive, canonical, internal links and sitemap policy.
2. Validate sitemap XML and inclusion rules. The book cites 50,000 URLs and 50 MB per file; verify current constraints during implementation. `lastmod` must follow real material changes, not the deployment clock. Segment maps to observe lifecycle or intent cohorts, not to promise extra authority.
3. Test migration pairs end to end and flatten accidental chains. Preserve relevant content and destinations. Check final content, canonical, links and sitemap after the redirect, not merely the first response code.
4. Compare source and rendered content on mobile. Exercise tabs, accordions, navigation and forms. Inspect readability, overflow, consent/advertising overlays and reserved image/ad dimensions on actual viewports.
5. Separate laboratory diagnostics from field outcomes by device and template. Trace LCP, INP, CLS and TTFB causes, then confirm that actual users can reach the answer and complete the task.

## Threshold interpretation

The source uses LCP 2.5 s, INP 200 ms, CLS 0.1 and tap targets around 48×48 px as practical reference values. They are not effect-size predictions or proof that a URL will rank. First-screen timing heuristics cannot replace interaction testing. Compiler addition: preserve raw measurement definitions and percentile/window metadata so comparable reports remain comparable.

## Done when

The matrix contains explicit expected results and sample receipts; important routes and resources work; mobile content parity and task completion pass; field rechecks are scheduled with enough data. A Lighthouse score alone is not a release acceptance record.

## Source and integration

Source: Доказательное SEO 2026, book 1 ch.3–5 pp.36–88; ch.15 pp.188–200. Resolve physical PDF page N to `/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/raw_pages/page_NNN.txt`. Cross-check the named procedures in [the registry](/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/procedures-registry.json). Active reference installed in `seo-release-protocol`.
